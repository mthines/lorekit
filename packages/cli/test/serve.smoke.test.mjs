// End-to-end SMOKE for `lorekit serve`: spawn the REAL published binary,
// seed a real on-disk store, and drive a full read + WRITE lifecycle
// (list → resolve synthetic id → PATCH → archive → restore) over HTTP against
// the live process — then prove each mutation actually landed on disk.
//
// Distinct from `test/serve.test.mjs`, which boots the HTTP factory IN-PROCESS:
// this exercises the wired path a user really hits — arg parsing →
// `resolveProjectRoot`/`localStoreDirs` store resolution → bound server →
// mutation → filesystem — so a regression in that wiring (not just a handler)
// fails here. The dashboard launch is stubbed via the LOREKIT_SERVE_WEB_CMD
// test seam so the smoke stays hermetic and needs no prebuilt bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTwoTierStore } from '../src/store/local.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

// Spawn `lorekit serve` over a freshly-seeded store, wait until the shim
// reports it is listening, and hand the caller the live base URL, the seeded
// store (to assert on-disk state), and a teardown that SIGINTs the process.
async function startServe() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-smoke-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-smoke-home-'));
  const store = createTwoTierStore({ home, project: null });

  // Seed two global lessons so the read + mutate lifecycle has real rows.
  await store.write({ scope: 'global', key: 'guard-clauses', value: 'prefer guard clauses over nesting', tags: ['style'], source_agent: 'claude' });
  await store.write({ scope: 'global', key: 'ternaries', value: 'avoid nested ternaries', tags: ['style'] });

  const child = spawn(
    process.execPath,
    [BIN, 'serve', '--port', '0', '--web-port', '0', '--no-open', '--dir', root],
    {
      env: {
        ...process.env,
        NO_COLOR: '1',
        LOREKIT_HOME: home,
        // Substitute a trivial long-running process for the dashboard launch.
        LOREKIT_SERVE_WEB_CMD: JSON.stringify({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });

  // The shim log line carries the bound URL: `shim: http://127.0.0.1:<port>/functions/v1`.
  const shimUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve did not report a shim URL within timeout.\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
      10000,
    );
    const check = () => {
      const match = stdout.match(/shim:\s*(http:\/\/127\.0\.0\.1:\d+\/functions\/v1)/i);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      } else if (child.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`serve exited early (code ${child.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  const teardown = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGINT');
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('serve did not exit after SIGINT')), 8000)),
    ]);
  };

  return { baseUrl: shimUrl, store, home, teardown };
}

async function api(baseUrl, path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: 'Bearer lorekit-local-dev-mode', ...(init.headers || {}) },
    ...init,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

test('smoke: the live `lorekit serve` process serves seeded lessons and round-trips a full edit lifecycle to disk', async () => {
  const { baseUrl, store, teardown } = await startServe();
  try {
    // ── read ──────────────────────────────────────────────────────────────
    const list = await api(baseUrl, '/memories');
    assert.equal(list.status, 200);
    const keys = list.body.entries.map((e) => e.key).sort();
    assert.deepEqual(keys, ['guard-clauses', 'ternaries']);

    const target = list.body.entries.find((e) => e.key === 'guard-clauses');
    assert.ok(target.id, 'a served entry carries a synthetic id');

    // ── edit (PATCH by synthetic id) reflected in the response AND on disk ──
    const patched = await api(baseUrl, `/memories/${encodeURIComponent(target.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'prefer guard clauses — EDITED via the dashboard' }),
    });
    assert.equal(patched.status, 200);
    assert.match(patched.body.value, /EDITED via the dashboard/);

    const onDisk = await store.read({ scope: 'global', key: 'guard-clauses' });
    assert.match(onDisk.entry.value, /EDITED via the dashboard/, 'the edit is persisted to the .md file, not just echoed');

    // A re-read through the live process agrees with disk.
    const reread = await api(baseUrl, `/memories/${encodeURIComponent(target.id)}`);
    assert.equal(reread.status, 200);
    assert.match(reread.body.value, /EDITED via the dashboard/);

    // ── archive (soft delete) drops it from the default list, keeps it in ?archived ──
    const archived = await api(baseUrl, `/memories?scope=${encodeURIComponent('global')}&key=guard-clauses`, { method: 'DELETE' });
    assert.equal(archived.status, 204);

    const afterArchive = await api(baseUrl, '/memories');
    assert.ok(!afterArchive.body.entries.some((e) => e.key === 'guard-clauses'), 'archived row is hidden from the active list');

    const archivedList = await api(baseUrl, '/memories?archived=true');
    assert.ok(archivedList.body.entries.some((e) => e.key === 'guard-clauses'), 'archived row appears in the archived partition');

    // ── restore brings it back ──────────────────────────────────────────────
    const restored = await api(baseUrl, '/memories/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'global', key: 'guard-clauses' }),
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.restored, true);

    const afterRestore = await api(baseUrl, '/memories');
    assert.ok(afterRestore.body.entries.some((e) => e.key === 'guard-clauses'), 'restored row is back in the active list');
  } finally {
    await teardown();
  }
});
