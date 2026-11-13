#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI in tests. Speaks just enough of
 * `-p --input-format stream-json --output-format stream-json` for the bridge.
 *
 * Behaviour depends on the last text in the user turn:
 *   contains "FAIL"  → is_error result, exit 1
 *   contains "TOOL"  → tool_use of the first --allowedTools entry, then hangs
 *                      (the bridge must stop it at message_stop)
 *   contains "SLOW"  → message_start, then hangs (for disconnect tests)
 *   otherwise        → a thinking block, then a text block "ECHO <json>"
 *                      describing what the CLI received
 * --model bogus → "issue with the selected model" error.
 * --version prints a version (the bridge probes it at startup).
 */
const fs = require('fs');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.0.0 (fake)');
  process.exit(0);
}

function arg(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
function argList(name) {
  const i = args.indexOf(name);
  if (i === -1) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]);
  return out;
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const ev = (event) => emit({ type: 'stream_event', event, parent_tool_use_id: null, session_id: 'fake' });
const model = arg('--model') || 'claude-fake-1';
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const msg = JSON.parse(input.split('\n')[0]);
  const content = msg.message.content;
  const texts = content.filter((b) => b.type === 'text').map((b) => b.text);
  const lastText = texts[texts.length - 1] || '';
  const systemFile = arg('--system-prompt-file');
  const system = systemFile ? fs.readFileSync(systemFile, 'utf8') : null;

  emit({ type: 'system', subtype: 'init', session_id: 'fake' });

  if (model === 'bogus') {
    emit({ type: 'result', is_error: true, result: `There's an issue with the selected model (${model}).` });
    process.exit(1);
  }
  if (lastText.includes('FAIL')) {
    emit({ type: 'result', is_error: true, result: 'boom' });
    process.exit(1);
  }

  ev({ type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });

  if (lastText.includes('SLOW')) {
    setInterval(() => {}, 1000);
    return;
  }

  if (lastText.includes('TOOL')) {
    const tool = argList('--allowedTools')[0];
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_fake', name: tool, input: {}, caller: { type: 'direct' } } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Vaduz"}' } });
    ev({ type: 'content_block_stop', index: 1 });
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } });
    ev({ type: 'message_stop' });
    // The real CLI would now run the tool and start another turn.
    setInterval(() => {}, 1000);
    return;
  }

  const echo = 'ECHO ' + JSON.stringify({ system, model, content, mcp: Boolean(arg('--mcp-config')), allowed: argList('--allowedTools') });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } });
  ev({ type: 'content_block_stop', index: 0 });
  ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  // Split the text across two deltas to exercise accumulation.
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: echo.slice(0, 10) } });
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: echo.slice(10) } });
  ev({ type: 'content_block_stop', index: 1 });
  ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
  ev({ type: 'message_stop' });
  emit({ type: 'result', is_error: false, result: echo, usage });
});
