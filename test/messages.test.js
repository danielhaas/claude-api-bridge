const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, parseSSE, echoOf } = require('./helpers');

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const user = (content) => ({ role: 'user', content });

describe('POST /v1/messages', () => {
  it('rejects missing and invalid keys with Anthropic-shaped errors', async () => {
    let r = await s.post('/v1/messages', { messages: [user('hi')] }, { 'x-api-key': '' });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.type, 'authentication_error');

    r = await s.post('/v1/messages', { messages: [user('hi')] }, { 'x-api-key': 'cab-nope' });
    assert.equal(r.status, 401);
  });

  it('accepts Authorization: Bearer as well', async () => {
    const r = await s.post('/v1/messages', { messages: [user('hi')] }, { 'x-api-key': '', authorization: `Bearer ${s.key}` });
    assert.equal(r.status, 200);
  });

  it('returns a message, passing system prompt and model through', async () => {
    const r = await s.post('/v1/messages', { model: 'claude-x', system: 'Be brief.', messages: [user('hello')] });
    assert.equal(r.status, 200);
    const msg = await r.json();
    assert.equal(msg.type, 'message');
    assert.equal(msg.stop_reason, 'end_turn');
    assert.equal(msg.usage.output_tokens, 12);
    // thinking block dropped (not requested), text block renumbered to the only block
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, 'text');
    const echo = echoOf(msg.content[0].text);
    assert.equal(echo.system, 'Be brief.');
    assert.equal(echo.model, 'claude-x');
    assert.deepEqual(echo.content, [{ type: 'text', text: 'hello' }]);
    assert.equal(echo.mcp, false);
  });

  it('keeps thinking blocks when thinking is requested', async () => {
    const r = await s.post('/v1/messages', { thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [user('hi')] });
    const msg = await r.json();
    assert.deepEqual(msg.content.map((b) => b.type), ['thinking', 'text']);
    assert.equal(msg.content[0].thinking, 'hmm');
  });

  it('folds earlier turns into a transcript', async () => {
    const r = await s.post('/v1/messages', {
      messages: [user('my color is teal'), { role: 'assistant', content: 'Noted.' }, user('what is it?')],
    });
    const echo = echoOf((await r.json()).content[0].text);
    assert.equal(echo.content.length, 2);
    assert.match(echo.content[0].text, /<user>\nmy color is teal\n<\/user>/);
    assert.match(echo.content[0].text, /<assistant>\nNoted.\n<\/assistant>/);
    assert.deepEqual(echo.content[1], { type: 'text', text: 'what is it?' });
  });

  it('validates requests', async () => {
    const cases = [
      [{}, /messages/],
      [{ messages: [user('a'), { role: 'assistant', content: 'b' }] }, /prefill/],
      [{ messages: [{ role: 'system', content: 'x' }] }, /role/],
      [{ model: 'bad model!', messages: [user('a')] }, /model/],
      [{ tools: [{ type: 'web_search_20250305', name: 'web_search' }], messages: [user('a')] }, /custom tools/],
      [{ tools: [{ name: 'bad name', input_schema: {} }], messages: [user('a')] }, /name/],
      [{ tools: [{ name: 'a' }], messages: [user('a')] }, /input_schema/],
      [{ tool_choice: { type: 'any' }, messages: [user('a')] }, /requires tools/],
    ];
    for (const [body, re] of cases) {
      const r = await s.post('/v1/messages', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      const err = await r.json();
      assert.equal(err.error.type, 'invalid_request_error');
      assert.match(err.error.message, re);
    }
  });

  it('maps CLI errors: unknown model → 404, other failures → 500', async () => {
    let r = await s.post('/v1/messages', { model: 'bogus', messages: [user('hi')] });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.type, 'not_found_error');

    r = await s.post('/v1/messages', { messages: [user('please FAIL')] });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error.message, 'boom');
  });

  it('streams standard SSE events', async () => {
    const r = await s.post('/v1/messages', { stream: true, messages: [user('hi')] });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const events = parseSSE(await r.text());
    assert.deepEqual(events.map((e) => e.event), [
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    for (const e of events) assert.equal(e.event, e.data.type);
    // thinking dropped → the text block is index 0
    assert.equal(events[1].data.index, 0);
  });

  it('returns tool calls and stops the CLI before it runs the tool', async () => {
    const started = Date.now();
    const r = await s.post('/v1/messages', {
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      messages: [user('TOOL please')],
    });
    const msg = await r.json();
    assert.ok(Date.now() - started < 3000, 'should not wait for the hanging CLI');
    assert.equal(msg.stop_reason, 'tool_use');
    assert.deepEqual(msg.content[1], { type: 'tool_use', id: 'toolu_fake', name: 'get_weather', input: { city: 'Vaduz' } });
  });

  it('offers tools to the CLI via MCP, unless tool_choice is none', async () => {
    const tools = [{ name: 'lookup', input_schema: { type: 'object' } }];
    let echo = echoOf((await (await s.post('/v1/messages', { tools, messages: [user('hi')] })).json()).content[0].text);
    assert.equal(echo.mcp, true);
    assert.deepEqual(echo.allowed, ['mcp__bridge__lookup']);

    echo = echoOf((await (await s.post('/v1/messages', { tools, tool_choice: { type: 'tool', name: 'lookup' }, messages: [user('hi')] })).json()).content[0].text);
    assert.match(echo.system, /must respond by calling the tool "lookup"/);

    echo = echoOf((await (await s.post('/v1/messages', { tools, tool_choice: { type: 'none' }, messages: [user('hi')] })).json()).content[0].text);
    assert.equal(echo.mcp, false);
  });

  it('turns tool_result blocks in the last message into text', async () => {
    const r = await s.post('/v1/messages', {
      messages: [
        user('weather?'),
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Bern' } }] },
        user([{ type: 'tool_result', tool_use_id: 't1', content: '9°C' }]),
      ],
    });
    const echo = echoOf((await r.json()).content[0].text);
    assert.match(echo.content[0].text, /\[tool call get_weather \(id t1\): {"city":"Bern"}\]/);
    assert.deepEqual(echo.content[1], { type: 'text', text: '[tool result for t1: 9°C]' });
  });

  it('kills the CLI when the client disconnects', async () => {
    const controller = new AbortController();
    const r = fetch(s.base + '/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': s.key },
      body: JSON.stringify({ stream: true, messages: [user('SLOW')] }),
    }).catch(() => {});
    await new Promise((res) => setTimeout(res, 500));
    controller.abort();
    await r;
    await new Promise((res) => setTimeout(res, 300));
    const row = s.db.getDb().prepare("SELECT status, error FROM requests WHERE source = 'v1' AND error = 'Client disconnected'").get();
    assert.ok(row, 'aborted request should be logged as disconnected');
  });

  it('logs /v1 calls without touching the /api/ask queue', async () => {
    const rows = s.db.getDb().prepare("SELECT status FROM requests WHERE source = 'v1'").all();
    assert.ok(rows.length > 5);
    assert.equal(s.db.getQueueLength(), 0);
    assert.equal(s.db.getQueuedRequests().length, 0);
  });
});

describe('POST /v1/messages/count_tokens', () => {
  it('returns an estimate', async () => {
    const r = await s.post('/v1/messages/count_tokens', { messages: [user('x'.repeat(400))] });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).input_tokens, 100);
  });
});

describe('GET /v1/models', () => {
  it('lists models in a shape both SDKs accept', async () => {
    const r = await s.get('/v1/models');
    const body = await r.json();
    assert.equal(body.object, 'list');
    assert.equal(body.has_more, false);
    const m = body.data.find((x) => x.id === 'claude-sonnet-5-5');
    assert.equal(m.type, 'model');
    assert.equal(m.object, 'model');
    assert.equal(m.display_name, 'Claude Sonnet 5.5');
  });

  it('gets one model or 404s', async () => {
    assert.equal((await s.get('/v1/models/claude-haiku-5-5')).status, 200);
    assert.equal((await s.get('/v1/models/nope')).status, 404);
  });

  it('requires a key', async () => {
    assert.equal((await s.get('/v1/models', { 'x-api-key': '' })).status, 401);
  });
});
