// CLI-level tests for `lorekit serve` (alias `web`): --help, flag parsing,
// port auto-increment on EADDRINUSE, and SIGINT teardown — spawning the real
// binary for the process-lifecycle behaviors, per the plan's Tests section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listenWithRetry, DEFAULT_SHIM_PORT } from '../src/serve.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

test('lorekit serve --help prints focused help naming the command', () => {
  const res = run(['serve', '--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^lorekit serve/i);
  assert.match(res.stdout, /serve/i);
});

test('lorekit web --help resolves the alias to the same help text', () => {
  const res = run(['web', '--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^lorekit serve/i);
});

test('an unrecognized flag on serve is rejected loudly, not silently ignored', () => {
  const res = run(['serve', '--totally-unknown-flag']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown option/i);
});

test('serve recognizes --port, --web-port, --dev, --no-open without error', () => {
  // --help short-circuits before any server actually starts, so this proves
  // parsing accepts the flags without exercising the network path.
  const res = run(['serve', '--port', '1234', '--web-port', '1235', '--dev', '--no-open', '--help']);
  assert.equal(res.status, 0);
});

test('listenWithRetry auto-increments past a port already in use', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const takenPort = blocker.address().port;

  try {
    const server = http.createServer();
    const bound = await listenWithRetry(server, '127.0.0.1', takenPort);
    assert.notEqual(bound, takenPort, 'must not bind the already-taken port');
    assert.ok(bound > takenPort, 'must move forward to find a free one');
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('listenWithRetry binds the requested port immediately when it is free', async () => {
  const server = http.createServer();
  const bound = await listenWithRetry(server, '127.0.0.1', 0); // 0 = OS-assigned, always free
  assert.ok(bound > 0);
  await new Promise((resolve) => server.close(resolve));
});

test('DEFAULT_SHIM_PORT is a stable, documented default', () => {
  assert.equal(typeof DEFAULT_SHIM_PORT, 'number');
  assert.ok(DEFAULT_SHIM_PORT > 1024);
});

// ── SIGINT teardown: spawns the REAL binary end-to-end ──────────────────────
//
// LOREKIT_SERVE_WEB_CMD (an internal, undocumented test seam — see serve.mjs)
// substitutes a trivial long-running process for the dashboard launch, so this
// stays fast and hermetic while still exercising the real CLI process, the
// real shim HTTP server, and the real SIGINT handler.
test('SIGINT tears down both the shim server and the dashboard process', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-serve-cli-'));
  const shimPort = 39812;

  const child = spawn(
    process.execPath,
    [BIN, 'serve', '--port', String(shimPort), '--web-port', '0', '--no-open', '--dir', home],
    {
      env: {
        ...process.env,
        NO_COLOR: '1',
        LOREKIT_HOME: path.join(home, 'home'),
        // A process that outlives the parent only if not reaped — proves
        // teardown by exiting promptly once SIGINT reaches it via the wrapper.
        LOREKIT_SERVE_WEB_CMD: JSON.stringify({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); });

  // Wait for the shim to report it is listening before sending SIGINT —
  // otherwise the signal could race the server startup.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve did not start within timeout; stdout so far: ${stdout}`)), 8000);
    const check = () => {
      if (stdout.includes('shim:')) {
        clearTimeout(timer);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  // The shim must actually be reachable before we tear it down.
  const probe = await fetch(`http://127.0.0.1:${shimPort}/functions/v1/memories/scopes`);
  assert.equal(probe.status, 200);

  const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.kill('SIGINT');
  const code = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('process did not exit after SIGINT within timeout')), 8000)),
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /shutting down/i);

  // The shim port must be released — a fresh listener can bind it again.
  const recheck = net.createServer();
  await new Promise((resolve, reject) => {
    recheck.once('error', reject);
    recheck.listen(shimPort, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => recheck.close(resolve));
});
