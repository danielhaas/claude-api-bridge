// Boots the bridge against the fake CLI with a throwaway data dir.
// Must be required before anything from src/ (env is read at load time).
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-test-'));
process.env.CAB_DATA_DIR = path.join(tmp, 'data');
process.env.CAB_WORKSPACE = path.join(tmp, 'workspace');
process.env.CAB_CLAUDE_BIN = path.join(__dirname, 'fixtures', 'fake-claude.js');

const db = require('../src/db');
const { createApp } = require('../src/server');

async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = db.createToken({ name: 'admin', isAdmin: true }).raw;
  const key = db.createToken({ name: 'test' }).raw;

  return {
    base,
    key,
    admin,
    db,
    async close() {
      server.closeAllConnections && server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
    post(p, body, headers = {}) {
      return fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, ...headers },
        body: JSON.stringify(body),
      });
    },
    get(p, headers = {}) {
      return fetch(base + p, { headers: { 'x-api-key': key, ...headers } });
    },
  };
}

/** Parse an SSE body into [{ event, data }]. */
function parseSSE(text) {
  return text.split('\n\n').filter(Boolean).map((chunk) => {
    const out = {};
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) out.event = line.slice(7);
      if (line.startsWith('data: ')) out.data = line.slice(6) === '[DONE]' ? '[DONE]' : JSON.parse(line.slice(6));
    }
    return out;
  });
}

/** The fake CLI answers "ECHO {json}"; return the parsed json. */
function echoOf(text) {
  if (!text.startsWith('ECHO ')) throw new Error(`not an echo: ${text}`);
  return JSON.parse(text.slice(5));
}

module.exports = { startServer, parseSSE, echoOf };
