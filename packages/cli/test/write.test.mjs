// `lorekit write <scope> <key> [value]` — create or update a memory from the CLI.
//
// Coverage:
//   • classic two-positional form: write <scope> <key> <value>
//   • shorthand form: write <scope::key> <value>
//   • --value flag
//   • stdin piping
//   • --json output shape
//   • missing-arg usage errors
//   • --local forces the offline store (no remote configured)
//   • --remote errors when remote is not configured
//   • deny-wins suppression
//   • persisted memory readable by `show` afterwards
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function seedProject() {
  const root = tmp('lk-write-proj-');
  const home = tmp('lk-write-home-');
  return { root, home };
}

// Run `lorekit write` synchronously.
function runWrite(root, home, extraArgs = [], extraEnv = {}, stdinInput = null) {
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
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [BIN, 'write', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env,
    input: stdinInput ?? undefined,
  });
}

// Run `lorekit show` synchronously (to verify a write).
function runShow(root, home, extraArgs = [], extraEnv = {}) {
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
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [BIN, 'show', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env,
  });
}

// ── classic two-positional form ───────────────────────────────────────────────

test('write creates a memory with the classic scope key value form (exit 0)', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'my-key', 'lesson body']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Written|Created|Updated/);
  assert.match(res.stdout, /global::my-key/);
});

test('write persists the memory so show can read it back', () => {
  const { root, home } = seedProject();
  runWrite(root, home, ['global', 'persist-test', 'the lesson value']);
  const showRes = runShow(root, home, ['global', 'persist-test']);
  assert.equal(showRes.status, 0, showRes.stderr);
  assert.match(showRes.stdout, /the lesson value/);
});

// ── scope::key shorthand ──────────────────────────────────────────────────────

test('write accepts scope::key shorthand form', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global::shorthand-key', 'shorthand body']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /global::shorthand-key/);
});

test('write scope::key shorthand persists and show can read it with shorthand too', () => {
  const { root, home } = seedProject();
  runWrite(root, home, ['global::shorthand-persist', 'value from shorthand']);
  // show also now accepts the shorthand
  const showRes = runShow(root, home, ['global::shorthand-persist']);
  assert.equal(showRes.status, 0, showRes.stderr);
  assert.match(showRes.stdout, /value from shorthand/);
});

// ── --value flag ──────────────────────────────────────────────────────────────

test('write --value flag provides the memory body', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'flag-key', '--value', 'from the flag']);
  assert.equal(res.status, 0, res.stderr);
  const showRes = runShow(root, home, ['global', 'flag-key']);
  assert.match(showRes.stdout, /from the flag/);
});

// ── stdin piping ──────────────────────────────────────────────────────────────

test('write reads value from stdin when no positional value and no --value', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'stdin-key'], {}, 'value from stdin');
  assert.equal(res.status, 0, res.stderr);
  const showRes = runShow(root, home, ['global', 'stdin-key']);
  assert.match(showRes.stdout, /value from stdin/);
});

// ── --json output ─────────────────────────────────────────────────────────────

test('write --json emits a structured result with scope, key, store, value', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'json-key', 'json body', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, 'global');
  assert.equal(out.key, 'json-key');
  assert.equal(out.value, 'json body');
  assert.equal(out.store, 'local'); // no remote configured
});

test('write --json with scope::key shorthand emits correct scope and key', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global::json-shorthand', 'shorthand json body', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, 'global');
  assert.equal(out.key, 'json-shorthand');
});

// ── --tags flag ───────────────────────────────────────────────────────────────

test('write --tags stores tags and show renders them', () => {
  const { root, home } = seedProject();
  runWrite(root, home, ['global', 'tagged-key', 'body', '--tags', 'aw,style']);
  const showRes = runShow(root, home, ['global', 'tagged-key']);
  assert.match(showRes.stdout, /aw/);
  assert.match(showRes.stdout, /style/);
});

test('write --json includes tags in output', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'tagged-json', 'body', '--tags', 'a,b', '--json']);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.tags, ['a', 'b']);
});

// ── upsert semantics ──────────────────────────────────────────────────────────

test('write updates an existing key (upsert)', () => {
  const { root, home } = seedProject();
  runWrite(root, home, ['global', 'upsert-key', 'first value']);
  runWrite(root, home, ['global', 'upsert-key', 'second value']);
  const showRes = runShow(root, home, ['global', 'upsert-key']);
  assert.match(showRes.stdout, /second value/);
  assert.doesNotMatch(showRes.stdout, /first value/); // old value replaced
});

// ── usage errors ──────────────────────────────────────────────────────────────

test('write without any positionals is a usage error', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('write with scope but no key is a usage error', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('write with scope and key but no value is an error', () => {
  const { root, home } = seedProject();
  // stdin is a TTY in spawnSync (no input), but we are not in a TTY either —
  // stdin.isTTY is false in a child process, so readStdin resolves to '' when
  // there is nothing to read. This exercises the empty-value error path.
  const res = runWrite(root, home, ['global', 'empty-value-key'], {}, '');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /non-empty value is required/);
});

test('write --remote and --local together is an error', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--remote', '--local']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /mutually exclusive/);
});

// ── --remote errors when not configured ──────────────────────────────────────

test('write --remote errors when no remote is configured', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--remote']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not configured/);
});

// ── deny-wins suppression ─────────────────────────────────────────────────────

test('LOREKIT_DENY=local errors when no remote configured', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 1);
  // No remote configured → no writable store available
  assert.match(res.stderr, /no writable store available|not configured/);
});

// ── show scope::key shorthand ─────────────────────────────────────────────────

test('show accepts scope::key shorthand (mirrors write shorthand)', () => {
  const { root, home } = seedProject();
  runWrite(root, home, ['global', 'show-shorthand-test', 'shorthand show value']);
  const res = runShow(root, home, ['global::show-shorthand-test']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /shorthand show value/);
});

test('show scope::key shorthand --json reports correct scope and key', () => {
  const { root, home } = seedProject();
  runWrite(root, home, ['global', 'show-json-shorthand', 'json value']);
  const res = runShow(root, home, ['global::show-json-shorthand', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scope, 'global');
  assert.equal(out.key, 'show-json-shorthand');
  assert.equal(out.offline.record.value, 'json value');
});

test('show with invalid scope::key (empty key part) is a usage error', () => {
  const { root, home } = seedProject();
  const res = runShow(root, home, ['global::']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});
