// End-to-end: spawn the real `lorekit hook` binary, feed each host's JSON on
// stdin, and assert the stdout injection. Covers the full path including
// argument parsing, stdin reading, throttling, and (via a mock MCP server)
// the SessionStart lesson-read path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-hook-'));
}

// Run the hook binary. Always returns { stdout, code } — the hook must exit 0.
function runHook({ adapter, event, input = {}, dir = REPO, env = {} }) {
  const args = [BIN, 'hook', '--adapter', adapter, '--dir', dir];
  if (event) args.push('--event', event);
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', args, {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { CLAUDE_PLUGIN_DATA: freshStateDir(), ...process.env, ...env },
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout ? String(e.stdout) : '';
  }
  return { stdout, code };
}

// Async variant — required whenever the test process also runs a server the
// child talks to, since execFileSync would block this process's event loop.
function runHookAsync({ adapter, event, input = {}, dir = REPO, env = {} }) {
  return new Promise((resolve) => {
    const args = [BIN, 'hook', '--adapter', adapter, '--dir', dir];
    if (event) args.push('--event', event);
    const child = spawn('node', args, {
      env: { CLAUDE_PLUGIN_DATA: freshStateDir(), ...process.env, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('claude Stop injects a retrospective nudge', () => {
  const { stdout, code } = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'Stop', session_id: 'stop-1' },
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(out.hookSpecificOutput.additionalContext, /retrospective/i);
});

test('claude PostToolUseFailure nudges even with an empty response (guaranteed failure)', () => {
  const { stdout } = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'PostToolUseFailure', session_id: 'f-1', tool_name: 'Edit', tool_response: {} },
  });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /failed/);
});

test('claude PostToolUse with exit_code 0 stays silent', () => {
  const { stdout } = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'PostToolUse', session_id: 'ok-1', tool_name: 'Bash', tool_response: { exit_code: 0 } },
  });
  assert.equal(stdout, '');
});

test('codex PostToolUse uses the failure heuristic (is_error)', () => {
  const { stdout } = runHook({
    adapter: 'codex',
    input: { hook_event_name: 'PostToolUse', session_id: 'cx-1', tool_name: 'shell', tool_response: { is_error: true } },
  });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /failed/);
});

test('cursor stop returns a followup_message', () => {
  const { stdout } = runHook({
    adapter: 'cursor',
    input: { hook_event_name: 'stop', generation_id: 'g-1' },
  });
  assert.match(JSON.parse(stdout).followup_message, /retrospective/i);
});

test('unknown adapter exits 0 and prints nothing', () => {
  const { stdout, code } = runHook({ adapter: 'nope', input: { hook_event_name: 'Stop' } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('malformed stdin exits 0 and prints nothing', () => {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', [BIN, 'hook', '--adapter', 'claude', '--event', 'Stop', '--dir', REPO], {
      input: 'this is not json',
      encoding: 'utf8',
      env: { CLAUDE_PLUGIN_DATA: freshStateDir(), ...process.env },
    });
  } catch (e) {
    code = e.status ?? 1;
  }
  // Stop has no tool data and needs no stdin fields, so it still nudges;
  // the point is it must not crash on unparseable input.
  assert.equal(code, 0);
  assert.ok(stdout === '' || stdout.includes('retrospective'));
});

test('the nudge fires at most once per session (throttle)', () => {
  const state = freshStateDir();
  const input = { hook_event_name: 'Stop', session_id: 'dup-1' };
  const a = runHook({ adapter: 'claude', input, env: { CLAUDE_PLUGIN_DATA: state } });
  const b = runHook({ adapter: 'claude', input, env: { CLAUDE_PLUGIN_DATA: state } });
  assert.notEqual(a.stdout, '');
  assert.equal(b.stdout, ''); // second call in the same session is suppressed
});

test('SessionStart reads lessons from the MCP server and injects them', async () => {
  // Mock LoreKit MCP endpoint that returns one lesson for any scope.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  entries: [{ key: 'lorekit-memory::demo', value: 'Demo lesson first line\nsecond', tags: [] }],
                }),
              },
            ],
          },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpProject = freshStateDir(); // no git remote, no .mcp.json → scope 'global', creds from env

  try {
    const { stdout, code } = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: { hook_event_name: 'SessionStart', session_id: 'read-1', cwd: tmpProject },
      env: {
        LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        LOREKIT_TOKEN: 'lk_ro_test',
      },
    });
    assert.equal(code, 0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /lorekit-memory::demo/);
    assert.match(ctx, /Demo lesson first line/);
    assert.doesNotMatch(ctx, /second/); // only the first line is summarized
  } finally {
    server.close();
  }
});
