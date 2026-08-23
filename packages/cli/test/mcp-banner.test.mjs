// `lorekit mcp` prints a human-readable readiness banner to STDERR when run
// interactively (stdin is a TTY), so a person doesn't see a silent hang — while
// a piped MCP client still gets a pristine, banner-free stdout AND stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { startupBanner, mcpServer } from '../src/commands/mcp-server.mjs';

// An input stream that ends immediately (no JSON-RPC frames), with a settable
// `isTTY` flag — the only thing the banner gate keys on.
function fakeInput({ isTTY = false } = {}) {
  const r = Readable.from([]);
  r.isTTY = isTTY;
  return r;
}

function collector() {
  const chunks = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  w.text = () => chunks.join('');
  return w;
}

test('startupBanner names the mode and is self-describing', () => {
  const b = startupBanner('local');
  assert.match(b, /local/);
  assert.match(b, /JSON-RPC/);
  assert.match(b, /ready/i);
});

test('interactive (TTY) run writes the banner to stderr, never to stdout', async () => {
  const output = collector();
  const errorOutput = collector();
  const code = await mcpServer({}, { input: fakeInput({ isTTY: true }), output, errorOutput });
  assert.equal(code, 0);
  assert.match(errorOutput.text(), /ready/i); // human sees reassurance
  assert.equal(output.text(), ''); // JSON-RPC channel stays pristine
});

test('piped run (no TTY) writes no banner — clients get a clean stderr', async () => {
  const output = collector();
  const errorOutput = collector();
  const code = await mcpServer({}, { input: fakeInput({ isTTY: false }), output, errorOutput });
  assert.equal(code, 0);
  assert.equal(errorOutput.text(), '');
  assert.equal(output.text(), '');
});
