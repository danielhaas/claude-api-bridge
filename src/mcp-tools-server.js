#!/usr/bin/env node
/**
 * Minimal stdio MCP server that advertises client-defined tools to the
 * Claude CLI. Used by /v1/messages to get native tool calls: the bridge
 * stops the CLI as soon as the model emits a tool_use, so tools/call is
 * normally never reached (it returns a placeholder if it is).
 *
 * Usage: node mcp-tools-server.js <tools.json>
 *   tools.json = [{ name, description, input_schema }, ...]
 */
const fs = require('fs');
const readline = require('readline');

const tools = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notification

  switch (req.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: (req.params && req.params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'bridge', version: '1.0.0' },
        },
      });
      break;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.input_schema || { type: 'object', properties: {} },
          })),
        },
      });
      break;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: { content: [{ type: 'text', text: 'The caller runs this tool; result pending.' }] },
      });
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id: req.id, result: {} });
      break;
    default:
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
});
