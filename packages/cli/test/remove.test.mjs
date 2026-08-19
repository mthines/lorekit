// `lorekit archive|delete|restore <scope::key>` — the removal lifecycle from the
// CLI, exercised against the offline (local) store so no remote is needed.
//
// Coverage:
//   • archive hides a memory, restore brings it back (round-trip)
//   • delete --force removes it outright (show can no longer find it)
//   • --json output shape
//   • missing-key usage error (exit 1)
//   • rm alias resolves to delete
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function baseEnv(home, extra = {}) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    LOREKIT_HOME: home,
    LOREKIT_TELEMETRY: '0',
  };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  return Object.assign(env, extra);
}

function run(cmd, root, home, extraArgs = []) {
  return spawnSync(process.execPath, [BIN, cmd, ...extraArgs, '--local', '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home),
  });
}

function seed() {
  const root = tmp('lk-rm-proj-');
  const home = tmp('lk-rm-home-');
  // A memory to operate on.
  const w = run('write', root, home, ['project::rm', 'k1', 'hello']);
  assert.equal(w.status, 0, `seed write failed: ${w.stderr}`);
  return { root, home };
}

test('archive then restore round-trips a memory', () => {
  const { root, home } = seed();

  const arch = run('archive', root, home, ['project::rm::k1']);
  assert.equal(arch.status, 0, `archive failed: ${arch.stderr}`);
  assert.match(arch.stdout, /archived/i);

  // After archive, `show` should not find the active row.
  const gone = run('show', root, home, ['project::rm::k1']);
  assert.notEqual(gone.status, 0, 'show should fail for an archived memory');

  const rest = run('restore', root, home, ['project::rm::k1']);
  assert.equal(rest.status, 0, `restore failed: ${rest.stderr}`);
  assert.match(rest.stdout, /restored/i);

  // Back again.
  const back = run('show', root, home, ['project::rm::k1']);
  assert.equal(back.status, 0, `show should find the restored memory: ${back.stderr}`);
});

test('delete --force removes a memory outright', () => {
  const { root, home } = seed();
  const del = run('delete', root, home, ['project::rm::k1', '--force']);
  assert.equal(del.status, 0, `delete --force failed: ${del.stderr}`);
  assert.match(del.stdout, /deleted/i);

  const gone = run('show', root, home, ['project::rm::k1']);
  assert.notEqual(gone.status, 0, 'show should fail after a hard delete');
});

test('archive --json reports a machine-readable outcome', () => {
  const { root, home } = seed();
  const arch = run('archive', root, home, ['project::rm::k1', '--json']);
  assert.equal(arch.status, 0, arch.stderr);
  const parsed = JSON.parse(arch.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.op, 'archive');
  assert.equal(parsed.scope, 'project::rm');
  assert.equal(parsed.key, 'k1');
  assert.equal(parsed.store, 'local');
});

test('missing key is a usage error', () => {
  const { root, home } = seed();
  const bad = run('delete', root, home, ['project::rm']); // scope only, no key
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /a scope and a key are required/i);
});

test('rm alias resolves to delete', () => {
  const { root, home } = seed();
  const rm = run('rm', root, home, ['project::rm::k1', '--force']);
  assert.equal(rm.status, 0, `rm alias failed: ${rm.stderr}`);
  const gone = run('show', root, home, ['project::rm::k1']);
  assert.notEqual(gone.status, 0);
});
