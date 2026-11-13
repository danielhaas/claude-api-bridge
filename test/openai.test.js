const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, parseSSE, echoOf } = require('./helpers');
const { toAnthropic, fromAnthropic } = require('../src/openai')._internal;

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const bearer = () => ({ 'x-api-key': '', authorization: `Bearer ${s.key}` });
const post = (body) => s.post('/v1/chat/completions', body, bearer());

describe('toAnthropic', () => {
  it('maps system, tools, tool calls and tool results', () => {
    const body = toAnthropic({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys A' },
        { role: 'developer', content: [{ type: 'text', text: 'sys B' }] },
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{"city":"Bern"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '9°C' },
      ],
      tools: [{ type: 'function', function: { name: 'w', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'required',
    });
    assert.equal(body.system, 'sys A\n\nsys B');
    assert.deepEqual(body.tools, [{ name: 'w', description: 'd', input_schema: { type: 'object' } }]);
    assert.deepEqual(body.tool_choice, { type: 'any' });
    assert.deepEqual(body.messages[1], { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'w', input: { city: 'Bern' } }] });
    assert.deepEqual(body.messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '9°C' }] });
  });

  it('converts data-URL images to base64 blocks', () => {
    const body = toAnthropic({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
    assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });

  it('merges consecutive same-role messages', () => {
    const body = toAnthropic({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] });
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content.length, 2);
  });

  it('rejects n > 1', () => {
    assert.throws(() => toAnthropic({ n: 2, messages: [{ role: 'user', content: 'a' }] }), /n: only 1/);
  });
});

describe('fromAnthropic', () => {
  it('maps text, tool calls, finish reason and usage', () => {
    const out = fromAnthropic({
      id: 'msg_123', model: 'm', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't', name: 'w', input: { a: 1 } }],
      usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 },
    }, 'm');
    assert.equal(out.id, 'chatcmpl-123');
    assert.equal(out.choices[0].finish_reason, 'tool_calls');
    assert.equal(out.choices[0].message.content, 'checking');
    assert.deepEqual(out.choices[0].message.tool_calls, [{ id: 't', type: 'function', function: { name: 'w', arguments: '{"a":1}' } }]);
    assert.equal(out.usage.prompt_tokens, 5);
    assert.equal(out.usage.total_tokens, 9);
  });
});

describe('POST /v1/chat/completions', () => {
  it('rejects bad keys with OpenAI-shaped errors', async () => {
    const r = await s.post('/v1/chat/completions', { messages: [] }, { 'x-api-key': '', authorization: 'Bearer nope' });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error.code, 'invalid_api_key');
  });

  it('returns a chat.completion', async () => {
    const r = await post({ model: 'claude-x', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].finish_reason, 'stop');
    const echo = echoOf(body.choices[0].message.content);
    assert.equal(echo.system, 'S');
    assert.equal(echo.model, 'claude-x');
    assert.equal(body.usage.completion_tokens, 12);
  });

  it('returns tool_calls', async () => {
    const r = await post({
      messages: [{ role: 'user', content: 'TOOL' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    });
    const body = await r.json();
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"city":"Vaduz"}');
  });

  it('streams chunks, usage and [DONE]', async () => {
    const r = await post({ stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const events = parseSSE(await r.text()).map((e) => e.data);
    assert.equal(events[events.length - 1], '[DONE]');
    const chunks = events.slice(0, -1);
    assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
    const text = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
    assert.ok(echoOf(text));
    assert.equal(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason, 'stop');
    assert.equal(chunks[chunks.length - 1].usage.completion_tokens, 12);
  });

  it('streams tool calls', async () => {
    const r = await post({
      stream: true,
      messages: [{ role: 'user', content: 'TOOL' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    });
    const chunks = parseSSE(await r.text()).map((e) => e.data).filter((d) => d !== '[DONE]');
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls || []);
    assert.equal(calls[0].function.name, 'get_weather');
    assert.equal(calls.map((c) => c.function.arguments).join(''), '{"city":"Vaduz"}');
    assert.equal(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason, 'tool_calls');
  });

  it('honours response_format json_schema and json_object', async () => {
    const schema = { type: 'object', properties: { rule_id: { type: 'string' } } };
    let r = await post({ response_format: { type: 'json_schema', json_schema: { name: 'pick', schema } }, messages: [{ role: 'user', content: 'pick' }] });
    let body = await r.json();
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.deepEqual(JSON.parse(body.choices[0].message.content).schema, schema);

    r = await post({ response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'pick' }] });
    body = await r.json();
    assert.deepEqual(JSON.parse(body.choices[0].message.content).schema, { type: 'object' });
  });

  it('maps errors to OpenAI shape', async () => {
    let r = await post({ model: 'bogus', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.type, 'invalid_request_error');

    r = await post({ messages: [{ role: 'user', content: 'FAIL' }] });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error.type, 'server_error');

    r = await post({ messages: [{ role: 'wizard', content: 'x' }] });
    assert.equal(r.status, 400);
  });
});
