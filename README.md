<p align="center">
  <h1 align="center">claude-api-bridge</h1>
  <p align="center">
    <strong>Use your Claude Code subscription through an API.</strong><br>
    Anthropic- and OpenAI-compatible endpoints, so existing SDKs and tools work unchanged.
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> •
    <a href="#how-it-works">How It Works</a> •
    <a href="#examples">Examples</a> •
    <a href="#api-reference">API Reference</a> •
    <a href="#run-as-a-service">Run as a Service</a>
  </p>
</p>

---

> This is a fork of [smy383/claude-api-bridge](https://github.com/smy383/claude-api-bridge).
> It adds Anthropic- and OpenAI-compatible endpoints (`/v1/messages`,
> `/v1/chat/completions`, `/v1/models`) with streaming, tool use and
> structured output, plus a test suite. The `claude-api-bridge` package on npm
> is the original and **doesn't have these features**, so install from this
> repository (see [Quick Start](#quick-start)).

## Why?

If you already pay for Claude Code, Claude is available in your terminal. **claude-api-bridge** puts an HTTP API in front of it, so your own scripts, tools and experiments can use it too.

It speaks the **Anthropic Messages API** and the **OpenAI Chat Completions API**. Anything built on the official `anthropic` or `openai` SDKs works if you change its base URL. There's also a simple submit-and-poll endpoint (`/api/ask`) and an optional Cloudflare Tunnel for remote access.

> **Read [Terms of use](#terms-of-use) first.** A Claude subscription is for your own use. Don't use this to serve other people, run a product, or process other people's data. Use an [Anthropic API key](https://console.anthropic.com/) for that.

## Features

| Feature | Description |
|---------|-------------|
| **🔌 Anthropic-compatible** | `POST /v1/messages`: the official SDKs work against it, with streaming |
| **🔁 OpenAI-compatible** | `POST /v1/chat/completions`: for libraries built on OpenAI |
| **🛠️ Tool use** | Your `tools` are offered to the model as real tools; you get `tool_use` / `tool_calls` back |
| **🧾 Structured output** | JSON-schema output (`output_config.format`, `output_format`, `response_format`), checked by Claude Code |
| **🔑 Token auth** | Create, revoke and expire API tokens. Only SHA256 hashes are stored |
| **🌐 Optional remote access** | Cloudflare Tunnel with HTTPS, no port forwarding |
| **📊 Web dashboard** | Requests, errors and queue at `/dashboard` |
| **🔒 Safeguards** | Rate limiting, CSP headers, size limits, timeouts, concurrency limit |
| **💾 Local storage** | SQLite file, no Redis, Postgres or cloud database |
| **✅ Tested** | `npm test` runs against a fake Claude CLI, so it uses none of your subscription |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude` on your `PATH`)
- An active Claude subscription that includes Claude Code

### Install & Run

```bash
git clone https://github.com/danielhaas/claude-api-bridge.git
cd claude-api-bridge
npm install
npm run dev        # local only: http://localhost:3456
# or: npm start    # also opens a public Cloudflare Tunnel
```

Or install it as a global command straight from GitHub:

```bash
npm install -g github:danielhaas/claude-api-bridge
claude-api-bridge start --no-tunnel
```

On the first start the bridge prints an **admin token**. It's shown only once, so save it:

```
  ✅  Claude Code CLI detected
  🔑  Admin Token (save this — shown only once!):
      cab-a1b2c3d4e5f6...
  🚀  API server running on http://localhost:3456
```

### Your First API Call

```bash
# 1. Create an API token with the admin token
curl -X POST http://localhost:3456/api/tokens \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app"}'
# → { "token": "cab-abc123...", "warning": "Save this token now." }

# 2. Call Claude, Anthropic-style
curl http://localhost:3456/v1/messages \
  -H "x-api-key: cab-abc123..." \
  -H "content-type: application/json" \
  -d '{"model": "claude-sonnet-5-5", "max_tokens": 1024,
       "messages": [{"role": "user", "content": "Write a Python function to check if a number is prime"}]}'
```

Use the **admin** token only for `/api/tokens`. Use the tokens you create with it for everything else.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│  Your app / script / SDK (anthropic, openai, curl, ...)  │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTP (localhost, SSH tunnel,
                            │ or optional Cloudflare Tunnel)
                            ▼
┌──────────────────────────────────────────────────────────┐
│  claude-api-bridge                       (your machine)  │
│                                                          │
│  Token auth ─┬─ /v1/messages ─────────┐                  │
│   (SHA256)   ├─ /v1/chat/completions ─┤→ claude -p ──────┼──→ Anthropic
│              │   (translated)         │  one turn, no    │   (your
│              │                        │  built-in tools  │    subscription)
│              └─ /api/ask → queue ─────┘                  │
│                                                          │
│  SQLite: tokens, request log, sessions                   │
└──────────────────────────────────────────────────────────┘
```

Each `/v1` request runs one non-interactive `claude -p` turn, with Claude Code's own tools (shell, file access and so on) turned off, so it behaves like a plain model call:

- **Streaming:** the CLI already outputs the API's own stream events, and the bridge passes them through.
- **Tool use:** your `tools` reach the model through a small built-in MCP server, so its calls are real, schema-checked tool calls. The bridge stops the CLI before it would run a tool itself and returns the call to you.
- **Structured output:** handled by the CLI's `--json-schema` option, which checks the answer against the schema and asks the model again if it doesn't match.

## Examples

### Anthropic SDK (Python)

```python
import anthropic

client = anthropic.Anthropic(api_key="cab-...", base_url="http://localhost:3456")

msg = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=1024,
    system="You are terse.",
    messages=[{"role": "user", "content": "Explain quantum computing in 3 sentences"}],
)
print(msg.content[0].text)

# Streaming
with client.messages.stream(model="claude-haiku-5-5", max_tokens=1024,
                            messages=[{"role": "user", "content": "Write a haiku"}]) as s:
    for text in s.text_stream:
        print(text, end="", flush=True)
```

### Tool use

```python
tools = [{
    "name": "get_weather",
    "description": "Current weather for a city",
    "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}]
messages = [{"role": "user", "content": "What's the weather in Vaduz?"}]

r = client.messages.create(model="claude-sonnet-5-5", max_tokens=1024, tools=tools, messages=messages)
call = next(b for b in r.content if b.type == "tool_use")   # stop_reason == "tool_use"

messages += [
    {"role": "assistant", "content": r.content},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call.id, "content": "14°C, light rain"}]},
]
r = client.messages.create(model="claude-sonnet-5-5", max_tokens=1024, tools=tools, messages=messages)
print(r.content[0].text)   # "It's 14°C with light rain in Vaduz."
```

### Structured output

```python
r = client.messages.create(
    model="claude-sonnet-5-5",
    max_tokens=1024,
    output_config={"format": {"type": "json_schema", "schema": {
        "type": "object",
        "properties": {"category": {"type": "string", "enum": ["billing", "login", "other"]},
                       "confidence": {"type": "number"}},
        "required": ["category", "confidence"],
        "additionalProperties": False,
    }}},
    messages=[{"role": "user", "content": "Ticket: I can't reset my password."}],
)
print(r.content[0].text)   # {"category":"login","confidence":0.95}
```

### OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(api_key="cab-...", base_url="http://localhost:3456/v1")
r = client.chat.completions.create(
    model="claude-sonnet-5-5",
    messages=[{"role": "system", "content": "Answer briefly."},
              {"role": "user", "content": "What is the capital of Liechtenstein?"}],
)
print(r.choices[0].message.content)
```

### Submit-and-poll (`/api/ask`)

The original endpoint. It runs Claude Code with its normal tools in a workspace folder (`~/claude-api-bridge-workspace`) and supports stateful sessions. Requests are queued and handled one at a time.

```bash
URL="http://localhost:3456"; TOKEN="cab-your-token-here"

ID=$(curl -s -X POST "$URL/api/ask" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "List 5 useful Linux commands"}' | jq -r '.requestId')

while true; do
  RESULT=$(curl -s "$URL/api/ask/$ID" -H "Authorization: Bearer $TOKEN")
  case $(echo "$RESULT" | jq -r '.status') in
    completed) echo "$RESULT" | jq -r '.response'; break ;;
    error)     echo "$RESULT" | jq -r '.error'; exit 1 ;;
  esac
  sleep 2
done
```

## API Reference

### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/v1/messages` | Token | Anthropic Messages API (sync + streaming, tools, structured output) |
| `POST` | `/v1/messages/count_tokens` | Token | Estimated input token count |
| `POST` | `/v1/chat/completions` | Token | OpenAI Chat Completions (sync + streaming, tools, `response_format`) |
| `GET` | `/v1/models` | Token | List models (works for Anthropic and OpenAI clients) |
| `GET` | `/v1/models/:id` | Token | Get one model |
| `POST` | `/api/ask` | Token | Queue a message for Claude Code |
| `GET` | `/api/ask/:requestId` | Token | Poll for the response |
| `POST` | `/api/tokens` | Admin | Create an API token |
| `GET` | `/api/tokens` | Admin | List tokens |
| `DELETE` | `/api/tokens/:id` | Admin | Revoke a token |
| `GET` | `/api/status` | — | Server status & stats |
| `GET` | `/dashboard` | — | Web dashboard |

`/v1` endpoints take the token as `x-api-key` or `Authorization: Bearer`. `/api` endpoints take `Authorization: Bearer`.

### POST /v1/messages

Works as a drop-in for the [Messages API](https://docs.anthropic.com/en/api/messages). It answers directly, so there's no polling, and `"stream": true` returns standard server-sent events. `model` takes full model IDs or Claude Code aliases such as `sonnet` and `haiku`. Leave it out to use Claude Code's default.

| Supported | Notes |
|-----------|-------|
| `system`, `messages`, `model`, `stream` | Text, images and documents in the last user message |
| `tools`, `tool_choice` | Custom tools. `tool_choice` `any`/`tool` are requested through the system prompt, because the CLI can't force a tool call. The model almost always follows it, but it isn't guaranteed |
| `output_config.format` / `output_format` | `{"type": "json_schema", "schema": {...}}`. The checked JSON comes back as one text block |
| `thinking` | Thinking blocks are returned only if you set it; otherwise they're removed |

Limitations, because it runs through the CLI:

- **Earlier turns** go to the model as a text transcript before the last user message. Images and documents only work in the last message.
- **Not supported:** assistant prefill and server tools such as web search. Both return `400`.
- **Ignored:** `max_tokens`, `temperature`, `top_p`, `top_k`, `stop_sequences`.
- **`usage`** includes Claude Code's own small system context.

### POST /v1/messages/count_tokens

Returns `{"input_tokens": n}`. It's an **estimate** (about 4 characters per token, plus a flat amount per image), because the CLI can't count tokens.

### POST /v1/chat/completions

OpenAI-compatible. Requests are converted to the Messages format, so the notes above apply as well. Supported:
- `system` and `developer` messages;
- image parts (data URLs or links);
- `tools`, `tool_calls` and `tool` messages;
- `tool_choice` (`auto`, `none`, `required` or a specific function);
- `response_format` (`json_schema` and `json_object`);
- `stream`, with `stream_options.include_usage`.

`n` must be 1.

### GET /v1/models

A fixed list, because the CLI can't list models. Each entry has the fields both Anthropic clients (`type`, `display_name`, `created_at`) and OpenAI clients (`object`, `owned_by`, `created`) expect. Change it with `CAB_MODELS=claude-opus-5-5,claude-haiku-5-5`. `created_at` is a placeholder.

### POST /api/ask

Queue a message for Claude Code. It runs with Claude Code's normal tools in `CAB_WORKSPACE`.

```json
{ "message": "Your prompt here (max 32KB)" }
```

**Response (202):**
```json
{ "ok": true, "requestId": "550e8400-...", "position": 1, "poll": "GET /api/ask/550e8400-..." }
```

### GET /api/ask/:requestId

| Status | HTTP | Body |
|--------|------|------|
| Queued | 202 | `{ "status": "queued", "queuePosition": 2 }` |
| Processing | 202 | `{ "status": "processing" }` |
| Completed | 200 | `{ "status": "completed", "response": "..." }` |
| Error | 200 | `{ "status": "error", "error": "..." }` |

### POST /api/tokens

Create an API token (admin only).

```json
{ "name": "my-script", "sessionMode": "stateless", "expiresInDays": 30 }
```

| Field | Type | Default | Options |
|-------|------|---------|---------|
| `name` | string | *required* | 1–100 characters |
| `sessionMode` | string | `"stateless"` | `"stateful"` / `"stateless"` (only affects `/api/ask`) |
| `expiresInDays` | number | `null` | `1`, `7`, `30`, `90`, or `null` (never) |

The raw token is returned once. Only its hash is stored.

### Errors

`/v1/messages` and `/v1/models` return Anthropic-style errors (`{"type": "error", "error": {"type", "message"}}`). `/v1/chat/completions` returns OpenAI-style errors (`{"error": {"message", "type", "code"}}`).

| HTTP | Meaning |
|------|---------|
| 400 | Invalid request (bad fields, unsupported feature) |
| 401 | Missing, invalid or expired token |
| 403 | Admin token required |
| 404 | Unknown model, request or token |
| 429 | Rate limit, `/api/ask` queue full, or subscription usage limit reached |
| 500 | Claude CLI failed |
| 504 | Request took longer than 5 minutes |
| 529 | Too many concurrent `/v1` requests |

## Run as a Service

To keep the bridge running across logouts and reboots on Linux, use a systemd **user** service (it runs as you, so it uses your Claude Code login):

```ini
# ~/.config/systemd/user/claude-api-bridge.service
[Unit]
Description=claude-api-bridge
After=network-online.target

[Service]
WorkingDirectory=/path/to/claude-api-bridge
ExecStart=/usr/bin/node /path/to/claude-api-bridge/bin/cli.js start --no-tunnel --port 3456
# systemd's default PATH usually lacks ~/.local/bin, where `claude` lives
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-api-bridge
loginctl enable-linger "$USER"                 # keep it running when you're logged out
journalctl --user -u claude-api-bridge -f      # logs (the admin token appears here on first start)
systemctl --user restart claude-api-bridge     # after updating the code
```

`--no-tunnel` is recommended for a service: the free Cloudflare URL changes on every restart. To reach the bridge from another machine, use an SSH tunnel (`ssh -L 3456:localhost:3456 your-host`) or a VPN.

## CLI Options

```
claude-api-bridge start [options]

Options:
  --port <number>    Server port (default: 3456)
  --no-tunnel        Local only, skip Cloudflare Tunnel

Other commands:
  --version, -v      Show version
  --help, -h         Show help
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3456` | Server port (`--port` wins) |
| `CAB_DATA_DIR` | `~/.claude-api-bridge` | Database location |
| `CAB_WORKSPACE` | `~/claude-api-bridge-workspace` | Working directory for CLI runs |
| `CAB_MAX_CONCURRENT` | `2` | `/v1` requests that run at once (20 more can wait) |
| `CAB_MODELS` | built-in list | Models returned by `/v1/models` |
| `CAB_CLAUDE_BIN` | auto-detected | Path to the `claude` binary |

## Security

| Measure | Details |
|---------|---------|
| **Token hashing** | Raw tokens are never stored, only SHA256 hashes |
| **No Claude Code tools on `/v1`** | Shell, file and web tools are turned off; your tools are returned to you, never run |
| **HTTPS** | Cloudflare Tunnel provides TLS when enabled |
| **Rate limiting** | 120 requests/minute overall |
| **Size limits** | 32KB per `/api/ask` message; 20MB per `/v1` request body (images, long conversations) |
| **Timeouts** | 5 minutes per request; Claude Code is stopped if the client disconnects |
| **Token expiration** | Optional expiry after 1/7/30/90 days |
| **Admin protection** | The last admin token can't be deleted |
| **Crash recovery** | Interrupted `/api/ask` jobs are re-queued on restart; interrupted `/v1` calls are marked failed |

**Things to know:**
- Claude Code adds your **account email** to the model's context. Anyone with a token could get the model to repeat it.
- With the tunnel on, the bridge is reachable from the internet, and anyone with a token can use your subscription. Hand out tokens accordingly, and prefer `--no-tunnel`.

## Limitations

| Limitation | Details |
|------------|---------|
| **Your machine must be on** | Claude Code runs locally |
| **Concurrency** | `/api/ask` runs one request at a time; `/v1` runs `CAB_MAX_CONCURRENT` (default 2) at once |
| **Subscription limits** | Requests count against your plan's usage limits; when you hit them, you get `429` |
| **Not the full API** | See the `/v1/messages` notes: no prefill, no server tools, sampling settings ignored |
| **Tunnel URL changes** | The free Cloudflare Tunnel gets a new URL on every restart. A [Cloudflare account](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives you a fixed domain |

## Development

```bash
npm install
npm test        # 35 tests against a fake claude CLI, no subscription usage
npm run dev     # local server, no tunnel
```

Layout: `src/messages.js` (the `/v1` core and the Anthropic endpoints), `src/openai.js` (OpenAI translation), `src/models.js`, `src/mcp-tools-server.js` (exposes your tools to the CLI), `src/routes.js` + `src/queue.js` (`/api/ask`), `test/fixtures/fake-claude.js` (the CLI stand-in the tests use).

## Data Storage

```
~/.claude-api-bridge/
├── bridge.db          # SQLite: tokens (hashed), request log, sessions
└── bin/
    └── cloudflared    # downloaded when the tunnel is first used

~/claude-api-bridge-workspace/   # working directory for Claude Code runs
```

Request logs are kept for 7 days. Data only leaves your machine to reach Anthropic (through Claude Code) and, if enabled, Cloudflare (the tunnel).

## Terms of Use

This project runs Claude Code on your behalf using your own subscription. Claude subscriptions are covered by Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and are meant for **your personal use**. In particular:

- **Don't share access:** don't share the bridge or its tokens with other people.
- **Don't run a business on it:** don't put a product, service or company workflow on it.
- **Don't process other people's data:** for example customer or client data. Consumer terms don't give you the data-processing guarantees that business use needs.

For any of that, use the [Anthropic API](https://console.anthropic.com/) with an API key. Because the bridge speaks the same API, switching later only means changing the base URL and the key.

The authors aren't affiliated with Anthropic and aren't responsible for misuse, terms violations or account actions.

## Contributing

Issues and pull requests are welcome. Run `npm test` before you submit.

## License

MIT © [mogee](https://github.com/smy383) (original project). Fork changes are released under the same license.

---

<p align="center">
  Originally built by the team behind <a href="https://ttapp-remote.com"><strong>ttapp</strong></a>, the mobile remote for Claude Code.
</p>
