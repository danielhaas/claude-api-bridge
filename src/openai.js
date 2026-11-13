/**
 * OpenAI-compatible Chat Completions: POST /v1/chat/completions
 *
 * Translates the request into an Anthropic Messages request, runs it through
 * the shared core in messages.js, and translates the result (or the stream)
 * back. Function calling maps onto the same native tool support.
 */
const express = require('express');
const { complete, validate, disconnectSignal, makeAuthenticate, ApiError } = require('./messages');

const router = express.Router();

// ── Errors ──────────────────────────────────────────────

const OPENAI_ERROR_TYPES = {
  invalid_request_error: 'invalid_request_error',
  authentication_error: 'authentication_error',
  not_found_error: 'invalid_request_error',
  rate_limit_error: 'rate_limit_error',
  overloaded_error: 'server_error',
  timeout_error: 'server_error',
  api_error: 'server_error',
};

function openaiError(type, message, code = null) {
  return { error: { message, type: OPENAI_ERROR_TYPES[type] || 'server_error', param: null, code } };
}

const authenticate = makeAuthenticate((status, type, message, res) =>
  res.status(status).json(openaiError(type, message, 'invalid_api_key')));

function bad(message) {
  return new ApiError(400, 'invalid_request_error', message);
}

// ── Request: OpenAI → Anthropic ─────────────────────────

function partToText(part) {
  if (typeof part === 'string') return part;
  if (part && (part.type === 'text' || part.type === 'input_text')) return part.text || '';
  return '';
}

function contentToText(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partToText).join('');
  throw bad('message content must be a string or an array of content parts');
}

function imagePartToBlock(part) {
  const url = (part.image_url && part.image_url.url) || part.image_url;
  if (typeof url !== 'string') throw bad('image_url.url is required');
  const m = url.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

function userContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw bad('user message content must be a string or an array');
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text || '' };
    if (part.type === 'image_url') return imagePartToBlock(part);
    throw bad(`unsupported content part type: ${part.type}`);
  });
}

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  try { return JSON.parse(args || '{}'); } catch { return { _raw: String(args) }; }
}

/** Append blocks to the last message if it has the same role, else start a new one. */
function push(out, role, blocks) {
  const last = out[out.length - 1];
  if (last && last.role === role) {
    const prev = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    last.content = prev.concat(blocks);
  } else {
    out.push({ role, content: blocks });
  }
}

function toAnthropic(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw bad('Request body must be a JSON object');
  if (!Array.isArray(req.messages) || req.messages.length === 0) throw bad('messages: must be a non-empty array');
  if (req.n !== undefined && req.n !== 1) throw bad('n: only 1 is supported');

  const system = [];
  const messages = [];

  for (const [i, m] of req.messages.entries()) {
    if (!m || typeof m !== 'object') throw bad(`messages[${i}]: must be an object`);
    switch (m.role) {
      case 'system':
      case 'developer':
        system.push(contentToText(m.content));
        break;
      case 'user': {
        const c = userContent(m.content);
        push(messages, 'user', typeof c === 'string' ? [{ type: 'text', text: c }] : c);
        break;
      }
      case 'assistant': {
        const blocks = [];
        const text = contentToText(m.content);
        if (text) blocks.push({ type: 'text', text });
        for (const call of m.tool_calls || []) {
          if (!call.function) continue;
          blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
        }
        if (blocks.length) push(messages, 'assistant', blocks);
        break;
      }
      case 'tool':
        push(messages, 'user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentToText(m.content) }]);
        break;
      default:
        throw bad(`messages[${i}].role: unsupported role "${m.role}"`);
    }
  }

  const body = {
    model: req.model,
    messages,
    stream: Boolean(req.stream),
  };
  if (system.length) body.system = system.join('\n\n');

  if (Array.isArray(req.tools) && req.tools.length) {
    body.tools = req.tools.map((t, i) => {
      if (!t || t.type !== 'function' || !t.function) throw bad(`tools[${i}]: only type "function" is supported`);
      return {
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} },
      };
    });
  }

  const tc = req.tool_choice;
  if (tc === 'none') body.tool_choice = { type: 'none' };
  else if (tc === 'auto') body.tool_choice = { type: 'auto' };
  else if (tc === 'required') body.tool_choice = { type: 'any' };
  else if (tc && typeof tc === 'object' && tc.function) body.tool_choice = { type: 'tool', name: tc.function.name };
  else if (tc !== undefined && tc !== null) throw bad('tool_choice: unsupported value');

  const rf = req.response_format;
  if (rf && rf.type === 'json_schema') {
    const schema = rf.json_schema && rf.json_schema.schema;
    if (!schema || typeof schema !== 'object') throw bad('response_format.json_schema.schema is required');
    body.output_config = { format: { type: 'json_schema', schema } };
  } else if (rf && rf.type === 'json_object') {
    body.output_config = { format: { type: 'json_schema', schema: { type: 'object' } } };
  } else if (rf && rf.type !== 'text') {
    throw bad(`response_format.type: unsupported value "${rf.type}"`);
  }

  return body;
}

// ── Response: Anthropic → OpenAI ────────────────────────

const FINISH_REASONS = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

function usageFrom(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const completion = u.output_tokens || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 },
  };
}

function completionId(messageId) {
  return 'chatcmpl-' + String(messageId || Date.now()).replace(/^msg_/, '');
}

function fromAnthropic(message, model) {
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = message.content.filter((b) => b.type === 'tool_use').map((b) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
  }));

  const msg = { role: 'assistant', content: text || (toolCalls.length ? null : ''), refusal: null };
  if (toolCalls.length) msg.tool_calls = toolCalls;

  return {
    id: completionId(message.id),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: message.model || model,
    choices: [{
      index: 0,
      message: msg,
      logprobs: null,
      finish_reason: FINISH_REASONS[message.stop_reason] || 'stop',
    }],
    usage: usageFrom(message.usage),
  };
}

/** Turns Anthropic stream events into OpenAI chat.completion.chunk objects. */
function makeChunker(model, includeUsage) {
  let id = completionId();
  let modelName = model;
  const created = Math.floor(Date.now() / 1000);
  const toolIndex = new Map(); // content block index → tool_calls index
  let usage = null;

  const chunk = (delta, finishReason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelName,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  });

  return (event) => {
    switch (event.type) {
      case 'message_start':
        id = completionId(event.message.id);
        modelName = event.message.model || modelName;
        usage = event.message.usage;
        return [chunk({ role: 'assistant', content: '' })];
      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          const i = toolIndex.size;
          toolIndex.set(event.index, i);
          return [chunk({
            tool_calls: [{
              index: i,
              id: event.content_block.id,
              type: 'function',
              function: { name: event.content_block.name, arguments: '' },
            }],
          })];
        }
        return [];
      case 'content_block_delta':
        if (event.delta.type === 'text_delta') return [chunk({ content: event.delta.text })];
        if (event.delta.type === 'input_json_delta' && toolIndex.has(event.index)) {
          return [chunk({ tool_calls: [{ index: toolIndex.get(event.index), function: { arguments: event.delta.partial_json } }] })];
        }
        return [];
      case 'message_delta': {
        if (event.usage) usage = { ...usage, ...event.usage };
        const out = [chunk({}, FINISH_REASONS[event.delta.stop_reason] || 'stop')];
        if (includeUsage) out.push({ ...chunk({}), choices: [], usage: usageFrom(usage) });
        return out;
      }
      default:
        return [];
    }
  };
}

// ── Route ───────────────────────────────────────────────

router.post('/v1/chat/completions', authenticate, async (req, res) => {
  let body;
  try {
    body = toAnthropic(req.body);
    validate(body);
  } catch (err) {
    return res.status(err.status || 400).json(openaiError(err.type || 'invalid_request_error', err.message));
  }

  const signal = disconnectSignal(res);
  const opts = { token: req.token, signal, label: '/v1/chat/completions' };

  if (!body.stream) {
    try {
      const message = await complete(body, opts);
      return res.json(fromAnthropic(message, body.model));
    } catch (err) {
      if (res.headersSent || signal.aborted) return;
      return res.status(err.status || 500).json(openaiError(err.type || 'api_error', err.message));
    }
  }

  const includeUsage = Boolean(req.body.stream_options && req.body.stream_options.include_usage);
  const toChunks = makeChunker(body.model, includeUsage);
  const writeRaw = (data) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    res.write(`data: ${data}\n\n`);
  };
  const write = (obj) => writeRaw(JSON.stringify(obj));

  try {
    await complete(body, { ...opts, onEvent: (event) => toChunks(event).forEach(write) });
  } catch (err) {
    if (signal.aborted) return;
    if (!res.headersSent) {
      return res.status(err.status || 500).json(openaiError(err.type || 'api_error', err.message));
    }
    write(openaiError(err.type || 'api_error', err.message));
  }
  writeRaw('[DONE]');
  res.end();
});

module.exports = { router, _internal: { toAnthropic, fromAnthropic, makeChunker } };
