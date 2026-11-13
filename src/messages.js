/**
 * Anthropic-compatible Messages API, plus the shared core that the OpenAI
 * route (openai.js) also runs on.
 *
 *   POST /v1/messages               sync or streaming (SSE)
 *   POST /v1/messages/count_tokens  rough estimate
 *
 * Each request runs one non-interactive `claude -p` turn with Claude Code's
 * built-in tools disabled. The CLI's stream-json output carries the raw
 * Messages API stream events, so streaming is close to a pass-through.
 *
 * Client tools are exposed to the CLI through a tiny MCP server
 * (mcp-tools-server.js), so the model makes native, schema-checked tool
 * calls. The CLI is stopped at the first message_stop, before it would run
 * the tool itself, and the tool_use block is returned to the caller.
 *
 * Limits of running on top of the CLI:
 *   - Earlier turns are folded into a text transcript (the CLI can't take
 *     assistant turns as input).
 *   - Assistant prefill and server tools (web search etc.) are not supported.
 *   - max_tokens, temperature, top_p, top_k and stop_sequences are ignored.
 */
const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const claude = require('./claude');

const router = express.Router();

const WORKING_DIR = path.join(claude.DEFAULT_WORKING_DIR, 'messages');
const MCP_SERVER = path.join(__dirname, 'mcp-tools-server.js');
const MCP_PREFIX = 'mcp__bridge__';
const EXECUTION_TIMEOUT = 300000; // 5 minutes
const MAX_CONCURRENT = parseInt(process.env.CAB_MAX_CONCURRENT || '2', 10);
const MAX_WAITING = 20;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ── Errors ──────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function errorBody(type, message) {
  return { type: 'error', error: { type, message } };
}

// ── Auth: x-api-key or Authorization: Bearer ────────────

/** @param {(status:number, type:string, message:string, res) => void} sendError */
function makeAuthenticate(sendError) {
  return (req, res, next) => {
    let raw = req.headers['x-api-key'];
    const authHeader = req.headers.authorization;
    if (!raw && authHeader && authHeader.startsWith('Bearer ')) {
      raw = authHeader.slice(7);
    }
    raw = (raw || '').trim();

    if (!raw) return sendError(401, 'authentication_error', 'Missing API key (x-api-key or Authorization: Bearer)', res);
    const token = db.verifyToken(raw);
    if (!token) return sendError(401, 'authentication_error', 'Invalid or expired API key', res);

    db.updateTokenLastUsed(token.id);
    req.token = token;
    next();
  };
}

const authenticate = makeAuthenticate((status, type, message, res) => res.status(status).json(errorBody(type, message)));

// ── Concurrency limit ───────────────────────────────────

let running = 0;
const waiting = [];

function acquire() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) {
    return Promise.reject(new ApiError(529, 'overloaded_error', 'Too many concurrent requests'));
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else running--;
}

// ── Validation ──────────────────────────────────────────

function toBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  throw new ApiError(400, 'invalid_request_error', 'message content must be a string or an array of blocks');
}

function blockToText(block) {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return '[image]';
    case 'document':
      return '[document]';
    case 'thinking':
    case 'redacted_thinking':
      return '';
    case 'tool_use':
      return `[tool call ${block.name} (id ${block.id}): ${JSON.stringify(block.input)}]`;
    case 'tool_result': {
      const inner = typeof block.content === 'string'
        ? block.content
        : (block.content || []).map(blockToText).join('\n');
      return `[tool result for ${block.tool_use_id}${block.is_error ? ' (error)' : ''}: ${inner}]`;
    }
    default:
      return '';
  }
}

/**
 * JSON schema for structured output, or null. Accepts the GA form
 * (output_config.format) and the beta form (output_format).
 */
function outputSchema(body) {
  const format = (body.output_config && body.output_config.format) || body.output_format;
  if (!format) return null;
  if (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object' || Array.isArray(format.schema)) {
    throw new ApiError(400, 'invalid_request_error', 'output format: only {"type": "json_schema", "schema": {...}} is supported');
  }
  return format.schema;
}

/** Client tools that will actually be offered to the model ([] if none or tool_choice none). */
function activeTools(body) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return [];
  if (body.tool_choice && body.tool_choice.type === 'none') return [];
  return body.tools;
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_request_error', 'Request body must be a JSON object');
  }
  const { messages, tools, model, tool_choice: toolChoice } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'invalid_request_error', 'messages: must be a non-empty array');
  }
  for (const [i, m] of messages.entries()) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw new ApiError(400, 'invalid_request_error', `messages.${i}.role: must be "user" or "assistant"`);
    }
    toBlocks(m.content);
  }
  if (messages[messages.length - 1].role !== 'user') {
    throw new ApiError(400, 'invalid_request_error',
      'The last message must have role "user" (assistant prefill is not supported by this bridge)');
  }
  if (model !== undefined && (typeof model !== 'string' || !/^[\w.\-\[\]:@]+$/.test(model))) {
    throw new ApiError(400, 'invalid_request_error', 'model: invalid model name');
  }
  systemText(body.system); // throws on bad shape
  outputSchema(body); // throws on bad shape

  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new ApiError(400, 'invalid_request_error', 'tools: must be an array');
    const names = new Set();
    for (const [i, t] of tools.entries()) {
      if (!t || (t.type && t.type !== 'custom')) {
        throw new ApiError(400, 'invalid_request_error',
          `tools.${i}: only custom tools are supported (server tools like web search are not)`);
      }
      if (typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) {
        throw new ApiError(400, 'invalid_request_error', `tools.${i}.name: must match ${TOOL_NAME_RE}`);
      }
      if (names.has(t.name)) throw new ApiError(400, 'invalid_request_error', `tools.${i}.name: duplicate "${t.name}"`);
      names.add(t.name);
      if (!t.input_schema || typeof t.input_schema !== 'object') {
        throw new ApiError(400, 'invalid_request_error', `tools.${i}.input_schema: required`);
      }
    }
  }
  if (toolChoice !== undefined) {
    const valid = ['auto', 'any', 'tool', 'none'];
    if (!toolChoice || !valid.includes(toolChoice.type)) {
      throw new ApiError(400, 'invalid_request_error', `tool_choice.type: must be one of ${valid.join(', ')}`);
    }
    if (toolChoice.type === 'tool' && !(tools || []).some((t) => t.name === toolChoice.name)) {
      throw new ApiError(400, 'invalid_request_error', 'tool_choice.name: must name one of the tools');
    }
    if ((toolChoice.type === 'any' || toolChoice.type === 'tool') && !(tools && tools.length)) {
      throw new ApiError(400, 'invalid_request_error', `tool_choice "${toolChoice.type}" requires tools`);
    }
  }
}

// ── Request → CLI input ─────────────────────────────────

function systemText(system) {
  if (system === undefined || system === null || system === '') return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (b && b.text) || '').join('\n\n');
  throw new ApiError(400, 'invalid_request_error', 'system: must be a string or an array of text blocks');
}

/** System prompt plus any tool_choice instruction (the CLI can't force tool use natively). */
function buildSystemPrompt(body) {
  let text = systemText(body.system);
  const choice = body.tool_choice;
  if (activeTools(body).length && choice) {
    let rule = null;
    if (choice.type === 'any') rule = 'You must respond by calling one of the available tools.';
    if (choice.type === 'tool') rule = `You must respond by calling the tool "${choice.name}".`;
    if (rule) text = text ? `${text}\n\n${rule}` : rule;
  }
  return text;
}

/**
 * Build the single user turn sent to the CLI. Earlier turns become a text
 * transcript in front of the last user message. The last message keeps its
 * text/image/document blocks (so images still work there); tool_result blocks
 * become text, since the CLI session has no matching tool_use to attach them to.
 */
function buildUserContent(messages) {
  const passThrough = new Set(['text', 'image', 'document']);
  const last = toBlocks(messages[messages.length - 1].content)
    .map((b) => (passThrough.has(b.type) ? b : { type: 'text', text: blockToText(b) }))
    .filter((b) => b.type !== 'text' || b.text);
  const history = messages.slice(0, -1);
  if (history.length === 0) return last;

  const transcript = history.map((m) => {
    const text = toBlocks(m.content).map(blockToText).filter(Boolean).join('\n');
    return `<${m.role}>\n${text}\n</${m.role}>`;
  }).join('\n\n');

  return [
    {
      type: 'text',
      text: 'The conversation so far:\n\n<conversation_history>\n' + transcript +
        '\n</conversation_history>\n\nContinue the conversation as the assistant. The latest user turn follows.',
    },
    ...last,
  ];
}

/** Text used to describe a request in the log/dashboard. */
function summarizeRequest(body) {
  const last = body.messages[body.messages.length - 1];
  const text = toBlocks(last.content).map(blockToText).filter(Boolean).join('\n');
  return text.slice(0, 2000) || '(no text)';
}

function summarizeResponse(message) {
  if (!message) return '';
  return message.content.map((b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `[tool call ${b.name}: ${JSON.stringify(b.input)}]`;
    return '';
  }).filter(Boolean).join('\n');
}

// ── Running the CLI ─────────────────────────────────────

function cliErrorFromResult(result, model) {
  const text = String(result.result || (result.errors && result.errors.join('; ')) || result.subtype || 'Claude CLI error');
  if (/issue with the selected model/i.test(text)) {
    return new ApiError(404, 'not_found_error', `model: ${model}`);
  }
  if (/usage limit|rate limit|limit reached/i.test(text)) {
    return new ApiError(429, 'rate_limit_error', text);
  }
  return new ApiError(500, 'api_error', text);
}

/**
 * Run one turn. Calls onEvent(event) for every raw stream event of the
 * top-level message. The CLI is stopped at the first message_stop.
 * Returns { abort, done }.
 */
function run(body, onEvent) {
  fs.mkdirSync(WORKING_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-'));

  // System prompt goes through a file: argv strings are capped at 128 KiB on Linux.
  const sysFile = path.join(tmp, 'system.txt');
  fs.writeFileSync(sysFile, buildSystemPrompt(body), { mode: 0o600 });

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt-file', sysFile,
  ];
  if (body.model) args.push('--model', body.model);

  // Structured output: the CLI makes the model call an internal
  // StructuredOutput tool, validates the input against the schema and asks
  // again if it doesn't match, so it needs a few turns. The validated JSON
  // arrives as result.structured_output.
  const schema = outputSchema(body);
  if (schema) args.push('--json-schema', JSON.stringify(schema), '--max-turns', '4');
  else args.push('--max-turns', '1');

  const tools = activeTools(body);
  if (tools.length) {
    const toolsFile = path.join(tmp, 'tools.json');
    const mcpFile = path.join(tmp, 'mcp.json');
    fs.writeFileSync(toolsFile, JSON.stringify(tools.map((t) => ({
      name: t.name, description: t.description, input_schema: t.input_schema,
    }))), { mode: 0o600 });
    fs.writeFileSync(mcpFile, JSON.stringify({
      mcpServers: { bridge: { type: 'stdio', command: process.execPath, args: [MCP_SERVER, toolsFile] } },
    }), { mode: 0o600 });
    args.push('--mcp-config', mcpFile, '--allowedTools', ...tools.map((t) => MCP_PREFIX + t.name));
  }

  const child = spawn(claude.CLAUDE_BIN, args, {
    cwd: WORKING_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_HEADLESS: '1' },
  });

  let stopReason = null; // why we killed it: 'complete' | 'timeout' | 'aborted'
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    child.kill('SIGTERM');
  };

  // Structured-output mode: hold back each message's events. A message that
  // calls a client tool is passed through (the caller must run the tool);
  // anything else is dropped, and the validated JSON is sent at the end.
  let firstStart = null;
  let held = [];
  let heldHasClientTool = false;
  const handleSchemaEvent = (event) => {
    if (event.type === 'message_start') {
      if (!firstStart) firstStart = event;
      held = [];
      heldHasClientTool = false;
    }
    held.push(event);
    if (event.type === 'content_block_start' && event.content_block && event.content_block.type === 'tool_use'
      && String(event.content_block.name).startsWith(MCP_PREFIX)) {
      heldHasClientTool = true;
    }
    if (event.type === 'message_stop' && heldHasClientTool) {
      held.forEach(onEvent);
      stop('complete');
    }
  };
  const emitStructured = (result) => {
    const start = firstStart ? firstStart.message : {
      id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant',
      model: body.model || 'unknown', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
    };
    onEvent({ type: 'message_start', message: { ...start, content: [], stop_reason: null } });
    onEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    onEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(result.structured_output) } });
    onEvent({ type: 'content_block_stop', index: 0 });
    onEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: (result.usage && result.usage.output_tokens) || 0 },
    });
    onEvent({ type: 'message_stop' });
  };

  const done = new Promise((resolve, reject) => {
    let buf = '';
    let stderr = '';
    let result = null;

    const timer = setTimeout(() => stop('timeout'), EXECUTION_TIMEOUT);
    const cleanup = () => {
      clearTimeout(timer);
      fs.rm(tmp, { recursive: true, force: true }, () => {});
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || stopReason) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
          if (schema) {
            handleSchemaEvent(msg.event);
          } else {
            onEvent(msg.event);
            // One message is all we want. Stopping here also keeps the CLI from
            // running a client tool itself.
            if (msg.event.type === 'message_stop') stop('complete');
          }
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    });

    child.stderr.on('data', (d) => {
      if (stderr.length < 64 * 1024) stderr += d.toString();
    });

    child.on('error', (err) => {
      cleanup();
      reject(new ApiError(500, 'api_error', `Failed to start Claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      cleanup();
      if (stopReason === 'complete') return resolve(result);
      if (stopReason === 'timeout') return reject(new ApiError(504, 'timeout_error', 'Request timed out'));
      if (stopReason === 'aborted') return reject(new ApiError(499, 'api_error', 'Client disconnected'));
      if (result && result.is_error) return reject(cliErrorFromResult(result, body.model));
      if (code !== 0) {
        return reject(new ApiError(500, 'api_error', `Claude CLI exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
      }
      if (schema) {
        if (!result || result.structured_output === undefined) {
          return reject(new ApiError(500, 'api_error', 'The model did not produce output matching the schema'));
        }
        emitStructured(result);
      }
      resolve(result);
    });
  });

  const input = { type: 'user', message: { role: 'user', content: buildUserContent(body.messages) } };
  child.stdin.on('error', () => {}); // CLI may exit before reading all input
  child.stdin.end(JSON.stringify(input) + '\n');

  return { abort: () => stop('aborted'), done };
}

// ── Stream event post-processing ────────────────────────

/**
 * Drops thinking blocks unless the request asked for thinking, renumbers the
 * remaining content blocks so indices stay contiguous, and strips the MCP
 * prefix from tool names.
 */
function makeEventFilter(keepThinking) {
  const indexMap = new Map();
  let nextIndex = 0;
  return (event) => {
    if (event.type === 'content_block_start') {
      const block = event.content_block || {};
      if (!keepThinking && (block.type === 'thinking' || block.type === 'redacted_thinking')) {
        indexMap.set(event.index, null);
        return null;
      }
      indexMap.set(event.index, nextIndex++);
      if (block.type === 'tool_use') {
        const { caller, ...rest } = block; // `caller` is a CLI-internal detail
        const name = rest.name && rest.name.startsWith(MCP_PREFIX) ? rest.name.slice(MCP_PREFIX.length) : rest.name;
        event = { ...event, content_block: { ...rest, name } };
      }
    }
    if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      const mapped = indexMap.get(event.index);
      if (mapped === null || mapped === undefined) return null;
      return { ...event, index: mapped };
    }
    return event;
  };
}

/** Rebuilds the final message object from stream events. */
function makeAccumulator() {
  let message = null;
  const blocks = [];
  const partialJson = [];

  return {
    add(event) {
      switch (event.type) {
        case 'message_start':
          message = { ...event.message, content: [] };
          break;
        case 'content_block_start':
          blocks[event.index] = { ...event.content_block };
          break;
        case 'content_block_delta': {
          const b = blocks[event.index];
          const d = event.delta;
          if (!b) break;
          if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
          else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
          else if (d.type === 'signature_delta') b.signature = d.signature;
          else if (d.type === 'input_json_delta') partialJson[event.index] = (partialJson[event.index] || '') + d.partial_json;
          break;
        }
        case 'content_block_stop':
          if (partialJson[event.index] !== undefined && blocks[event.index]) {
            try { blocks[event.index].input = JSON.parse(partialJson[event.index] || '{}'); } catch { /* keep as-is */ }
          }
          break;
        case 'message_delta':
          if (message) {
            Object.assign(message, event.delta);
            if (event.usage) message.usage = { ...message.usage, ...event.usage };
          }
          break;
        default:
          break;
      }
    },
    result() {
      if (!message) return null;
      return { ...message, content: blocks.filter(Boolean) };
    },
  };
}

// ── Shared core ─────────────────────────────────────────

/**
 * Run a validated Anthropic-shaped request end to end: concurrency limit,
 * logging to the requests table, event filtering, abort handling.
 *
 * @param {object} body       validated Messages API request
 * @param {object} opts
 * @param {object} opts.token authenticated token row
 * @param {(event) => void} [opts.onEvent] receives filtered stream events
 * @param {AbortSignal} [opts.signal] aborts the CLI (client disconnect)
 * @param {string} [opts.label] for console logs
 * @returns {Promise<object>} the final assistant message
 */
async function complete(body, { token, onEvent, signal, label = '/v1/messages' }) {
  await acquire();

  const id = crypto.randomUUID();
  const tag = id.slice(0, 8);
  const startedAt = Date.now();
  db.logV1Start({ id, tokenId: token.id, message: summarizeRequest(body) });
  console.log(`  ⚡  ${label} ${tag} (${body.model || 'default model'}${body.stream ? ', stream' : ''})`);

  const keepThinking = Boolean(body.thinking && body.thinking.type && body.thinking.type !== 'disabled');
  const filter = makeEventFilter(keepThinking);
  const acc = makeAccumulator();

  try {
    if (signal && signal.aborted) throw new ApiError(499, 'api_error', 'Client disconnected');

    const r = run(body, (event) => {
      const e = filter(event);
      if (!e) return;
      acc.add(e);
      if (onEvent) onEvent(e);
    });
    const onAbort = () => r.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    let result;
    try {
      result = await r.done;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    let message = acc.result();
    if (!message) {
      // No stream events came back; fall back to the CLI's final result text.
      message = {
        id: `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        model: body.model || 'unknown',
        content: [{ type: 'text', text: (result && result.result) || '' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: (result && result.usage) || { input_tokens: 0, output_tokens: 0 },
      };
    }

    db.updateRequest(id, { status: 'completed', response: summarizeResponse(message) });
    console.log(`  ✅  ${label} ${tag} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    return message;
  } catch (err) {
    db.updateRequest(id, { status: 'error', error: err.message });
    console.error(`  ❌  ${label} ${tag} failed: ${err.message}`);
    throw err;
  } finally {
    release();
  }
}

/** AbortSignal that fires when the client connection closes before we finish. */
function disconnectSignal(res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

// ── Token estimate ──────────────────────────────────────

/** Rough input-token estimate (~4 characters per token; images ~1.6k tokens). */
function estimateTokens(body) {
  let chars = buildSystemPrompt(body).length;
  let extra = 0;
  for (const m of body.messages) {
    for (const b of toBlocks(m.content)) {
      if (b.type === 'image') extra += 1600;
      else if (b.type === 'document') extra += 3000;
      else chars += blockToText(b).length;
    }
  }
  if (Array.isArray(body.tools)) chars += JSON.stringify(body.tools).length;
  return Math.max(1, Math.ceil(chars / 4) + extra);
}

// ── Routes ──────────────────────────────────────────────

router.post('/v1/messages', authenticate, async (req, res) => {
  const body = req.body;
  try {
    validate(body);
  } catch (err) {
    return res.status(err.status || 400).json(errorBody(err.type || 'invalid_request_error', err.message));
  }

  const signal = disconnectSignal(res);

  if (!body.stream) {
    try {
      const message = await complete(body, { token: req.token, signal });
      return res.json(message);
    } catch (err) {
      if (res.headersSent || signal.aborted) return;
      return res.status(err.status || 500).json(errorBody(err.type || 'api_error', err.message));
    }
  }

  const send = (event) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await complete(body, { token: req.token, signal, onEvent: send });
    res.end();
  } catch (err) {
    if (signal.aborted) return;
    if (!res.headersSent) {
      return res.status(err.status || 500).json(errorBody(err.type || 'api_error', err.message));
    }
    send(errorBody(err.type || 'api_error', err.message));
    res.end();
  }
});

router.post('/v1/messages/count_tokens', authenticate, (req, res) => {
  const body = req.body;
  try {
    validate({ ...body, stream: false });
  } catch (err) {
    return res.status(err.status || 400).json(errorBody(err.type || 'invalid_request_error', err.message));
  }
  res.json({ input_tokens: estimateTokens(body) });
});

module.exports = {
  router,
  // shared core for openai.js
  complete,
  validate,
  disconnectSignal,
  makeAuthenticate,
  ApiError,
  // exported for tests
  _internal: {
    buildUserContent,
    buildSystemPrompt,
    makeEventFilter,
    makeAccumulator,
    estimateTokens,
    activeTools,
    MCP_PREFIX,
  },
};
