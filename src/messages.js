/**
 * Anthropic-compatible Messages API: POST /v1/messages
 *
 * Each request runs one non-interactive `claude -p` turn with every tool
 * disabled. The CLI's stream-json output carries the raw Messages API stream
 * events, so streaming responses are passed through almost unchanged.
 *
 * Limits of running on top of the CLI:
 *   - Earlier turns are folded into a text transcript (the CLI can't take
 *     assistant turns as input).
 *   - Client-side `tools` and assistant prefill are not supported (400).
 *   - max_tokens, temperature, top_p, top_k and stop_sequences are accepted
 *     but ignored.
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
const EXECUTION_TIMEOUT = 300000; // 5 minutes
const MAX_CONCURRENT = parseInt(process.env.CAB_MAX_CONCURRENT || '2', 10);
const MAX_WAITING = 20;

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

function authenticate(req, res, next) {
  let raw = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;
  if (!raw && authHeader && authHeader.startsWith('Bearer ')) {
    raw = authHeader.slice(7);
  }
  raw = (raw || '').trim();

  if (!raw) {
    return res.status(401).json(errorBody('authentication_error', 'Missing x-api-key header'));
  }
  const token = db.verifyToken(raw);
  if (!token) {
    return res.status(401).json(errorBody('authentication_error', 'Invalid or expired API key'));
  }
  db.updateTokenLastUsed(token.id);
  req.token = token;
  next();
}

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

// ── Request → CLI input ─────────────────────────────────

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
      return `[tool call ${block.name}: ${JSON.stringify(block.input)}]`;
    case 'tool_result': {
      const inner = typeof block.content === 'string'
        ? block.content
        : (block.content || []).map(blockToText).join('\n');
      return `[tool result: ${inner}]`;
    }
    default:
      return '';
  }
}

function validate(body) {
  if (!body || typeof body !== 'object') {
    throw new ApiError(400, 'invalid_request_error', 'Request body must be a JSON object');
  }
  const { messages, tools, model } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'invalid_request_error', 'messages: must be a non-empty array');
  }
  for (const [i, m] of messages.entries()) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw new ApiError(400, 'invalid_request_error', `messages.${i}.role: must be "user" or "assistant"`);
    }
  }
  if (messages[messages.length - 1].role !== 'user') {
    throw new ApiError(400, 'invalid_request_error',
      'The last message must have role "user" (assistant prefill is not supported by this bridge)');
  }
  if (Array.isArray(tools) && tools.length > 0) {
    throw new ApiError(400, 'invalid_request_error', 'tools are not supported by this bridge');
  }
  if (model !== undefined && (typeof model !== 'string' || !/^[\w.\-\[\]:@]+$/.test(model))) {
    throw new ApiError(400, 'invalid_request_error', 'model: invalid model name');
  }
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => b.text || '').join('\n\n');
  throw new ApiError(400, 'invalid_request_error', 'system: must be a string or an array of text blocks');
}

/**
 * Build the single user turn sent to the CLI. Earlier turns become a text
 * transcript in front of the last user message; the last message keeps its
 * original blocks (so images and documents still work there).
 */
function buildUserContent(messages) {
  const last = toBlocks(messages[messages.length - 1].content);
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
        '\n</conversation_history>\n\nContinue the conversation as the assistant. The user\'s latest message follows.',
    },
    ...last,
  ];
}

// ── Running the CLI ─────────────────────────────────────

/**
 * Run one turn. Calls onEvent(event) for every raw Messages API stream event
 * of the top-level message. Resolves when the CLI exits; rejects on failure.
 * Returns { child, done } so the caller can abort (e.g. client disconnect).
 */
function run(body, onEvent) {
  fs.mkdirSync(WORKING_DIR, { recursive: true });

  // System prompt goes through a file: argv strings are capped at 128 KiB on Linux.
  const sysFile = path.join(os.tmpdir(), `cab-system-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(sysFile, systemText(body.system), { mode: 0o600 });

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
    '--max-turns', '1',
    '--system-prompt-file', sysFile,
  ];
  if (body.model) args.push('--model', body.model);

  const child = spawn(claude.CLAUDE_BIN, args, {
    cwd: WORKING_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_HEADLESS: '1' },
  });

  const done = new Promise((resolve, reject) => {
    let buf = '';
    let stderr = '';
    let result = null;
    let killed = null;

    const timer = setTimeout(() => {
      killed = 'Request timed out';
      child.kill('SIGTERM');
    }, EXECUTION_TIMEOUT);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
          onEvent(msg.event);
        } else if (msg.type === 'result') {
          result = msg;
        }
      }
    });

    child.stderr.on('data', (d) => {
      if (stderr.length < 64 * 1024) stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      fs.rm(sysFile, { force: true }, () => {});
      reject(new ApiError(500, 'api_error', `Failed to start Claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rm(sysFile, { force: true }, () => {});
      if (killed) return reject(new ApiError(504, 'timeout_error', killed));
      if (result && result.is_error) {
        const text = String(result.result || result.subtype || 'Claude CLI error');
        if (/issue with the selected model/i.test(text)) {
          return reject(new ApiError(404, 'not_found_error', `model: ${body.model}`));
        }
        return reject(new ApiError(500, 'api_error', text));
      }
      if (code !== 0) {
        return reject(new ApiError(500, 'api_error', `Claude CLI exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
      }
      resolve(result);
    });
  });

  const input = { type: 'user', message: { role: 'user', content: buildUserContent(body.messages) } };
  child.stdin.on('error', () => {}); // CLI may exit before reading all input
  child.stdin.end(JSON.stringify(input) + '\n');

  return { child, done };
}

/**
 * The CLI may produce thinking blocks even when the request didn't ask for
 * them. This filter drops them (unless thinking was requested) and renumbers
 * the remaining content blocks so indices stay contiguous.
 */
function makeBlockFilter(keepThinking) {
  const indexMap = new Map();
  let nextIndex = 0;
  return (event) => {
    if (event.type === 'content_block_start') {
      const t = event.content_block && event.content_block.type;
      if (!keepThinking && (t === 'thinking' || t === 'redacted_thinking')) {
        indexMap.set(event.index, null);
        return null;
      }
      indexMap.set(event.index, nextIndex++);
    }
    if (event.type === 'content_block_start' || event.type === 'content_block_delta' || event.type === 'content_block_stop') {
      const mapped = indexMap.get(event.index);
      if (mapped === null || mapped === undefined) return null;
      return { ...event, index: mapped };
    }
    return event;
  };
}

/** Rebuilds the final message object from stream events (for stream: false). */
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
          if (partialJson[event.index] !== undefined) {
            try { blocks[event.index].input = JSON.parse(partialJson[event.index]); } catch { /* keep as-is */ }
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

// ── Route ───────────────────────────────────────────────

router.post('/v1/messages', authenticate, async (req, res) => {
  const body = req.body;
  const startedAt = Date.now();
  const tag = crypto.randomUUID().slice(0, 8);

  try {
    validate(body);
  } catch (err) {
    return res.status(err.status || 400).json(errorBody(err.type || 'invalid_request_error', err.message));
  }

  try {
    await acquire();
  } catch (err) {
    return res.status(err.status).json(errorBody(err.type, err.message));
  }

  const filter = makeBlockFilter(Boolean(body.thinking && body.thinking.type !== 'disabled'));
  let child = null;
  let finished = false;

  // Abort the CLI if the client goes away.
  res.on('close', () => {
    if (!finished && child) child.kill('SIGTERM');
  });

  console.log(`  ⚡  /v1/messages ${tag} (${body.model || 'default model'}${body.stream ? ', stream' : ''})`);

  try {
    if (body.stream) {
      let headersSent = false;
      const send = (event) => {
        if (!headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          headersSent = true;
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const r = run(body, (event) => {
        const e = filter(event);
        if (e) send(e);
      });
      child = r.child;

      try {
        await r.done;
      } catch (err) {
        if (!headersSent) throw err;
        res.write(`event: error\ndata: ${JSON.stringify(errorBody(err.type || 'api_error', err.message))}\n\n`);
      }
      finished = true;
      res.end();
    } else {
      const acc = makeAccumulator();
      const r = run(body, (event) => {
        const e = filter(event);
        if (e) acc.add(e);
      });
      child = r.child;
      const result = await r.done;
      finished = true;

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
      res.json(message);
    }
    console.log(`  ✅  /v1/messages ${tag} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (err) {
    finished = true;
    console.error(`  ❌  /v1/messages ${tag} failed: ${err.message}`);
    if (!res.headersSent) {
      res.status(err.status || 500).json(errorBody(err.type || 'api_error', err.message));
    } else {
      res.end();
    }
  } finally {
    release();
  }
});

module.exports = router;
