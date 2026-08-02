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

// ── TTL / expiry flags on a local write ───────────────────────────────────────

test('write --local --ttl-days sets expires_at on the offline row', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '30', '--json']);
  assert.equal(res.status, 0);
  const files = fs.readdirSync(path.join(home, 'global'));
  const onDisk = fs.readFileSync(path.join(home, 'global', files[0]), 'utf8');
  const m = /expires_at: "([^"]+)"/.exec(onDisk);
  assert.ok(m, 'expires_at is persisted to frontmatter');
  const days = (Date.parse(m[1]) - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29 && days < 31, `expiry ≈ 30 days out (got ${days})`);
});

test('write --local --clear-ttl removes an existing expiry', () => {
  const { root, home } = seedProject();
  runWrite(root, home, ['global', 'k', 'v1', '--local', '--ttl-days', '30']);
  const res = runWrite(root, home, ['global', 'k', 'v2', '--local', '--clear-ttl', '--json']);
  assert.equal(res.status, 0);
  const files = fs.readdirSync(path.join(home, 'global'));
  const onDisk = fs.readFileSync(path.join(home, 'global', files[0]), 'utf8');
  assert.match(onDisk, /expires_at: null/);
});

// `--clear-ttl` beats `--ttl-days` inside resolveExpiresAt (the memory_write
// tri-state, migrations 00030/00031), so the row that lands is permanent. The
// REPORT has to follow the same precedence: it previously described the flag
// the user typed, so this combination printed "expires in 7 days" and reported
// ttl_days 7 for a row whose expires_at is null — the one thing --clear-ttl is
// supposed to guarantee.
test('write --local --ttl-days with --clear-ttl reports permanent, not the flag', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '7', '--clear-ttl', '--json']);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ttl_days, null);
  assert.equal(out.ttl_source, 'none');
  const files = fs.readdirSync(path.join(home, 'global'));
  const onDisk = fs.readFileSync(path.join(home, 'global', files[0]), 'utf8');
  assert.match(onDisk, /expires_at: null/);
});

test('write --local --ttl-days with --clear-ttl prints no expiry line', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '7', '--clear-ttl']);
  assert.equal(res.status, 0);
  assert.doesNotMatch(res.stdout, /expires in/);
});

// Guard the other half of the precedence: a bare --ttl-days must keep reporting
// the flag, or the fix above would have traded one wrong report for another.
test('write --local --ttl-days alone still reports the flag as the source', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '7', '--json']);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ttl_days, 7);
  assert.equal(out.ttl_source, 'flag');
});

test('write --local --ttl-days rejects an out-of-range value', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '999']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /365/);
});

// A supplied `--ttl-days` must always reach the validator. These three inputs used
// to be swallowed by a truthiness test and exit 0 having written no expiry at all,
// which is indistinguishable from a permanent memory — the one thing `--clear-ttl`
// is for. Each must now be a usage error that writes nothing.
test('write --local --ttl-days 0 is a usage error and writes nothing', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '0']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /ttl-days/);
  assert.equal(fs.existsSync(path.join(home, 'global')), false, 'no row was written');
});

test('write --local --ttl-days with a non-numeric value is a usage error', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', 'abc']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /ttl-days/);
  assert.equal(fs.existsSync(path.join(home, 'global')), false, 'no row was written');
});

test('write --local with a bare --ttl-days (no value) is a usage error, not 1 day', () => {
  const { root, home } = seedProject();
  // `--ttl-days` immediately followed by another flag leaves it valueless.
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '--json']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /ttl-days/);
  assert.equal(fs.existsSync(path.join(home, 'global')), false, 'no row was written');
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

// ── Configured default TTL (ttl.default / scope.defaults) ─────────────────────
// End-to-end through the binary, asserted on the frontmatter the local store
// actually persisted — a resolver that is correct but never called would still
// fail these.

// Days until `expires_at`, or null when the row is permanent. Walks the home
// tier rather than joining `home` with the scope: the local store slugifies a
// scope into a directory name, so a `branch::owner/repo::feat-x` scope is not
// literally that path. Each of these tests writes exactly one memory.
function expiryDays(home) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) found.push(full);
    }
  };
  walk(home);
  assert.equal(found.length, 1, `expected exactly one memory on disk, got ${found.length}`);
  const m = /expires_at: "([^"]+)"/.exec(fs.readFileSync(found[0], 'utf8'));
  if (!m) return null;
  return (Date.parse(m[1]) - Date.now()) / (24 * 60 * 60 * 1000);
}

function writeRepoConfig(root, config) {
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify(config, null, 2));
}

test('write applies ttl.default from the repo config when no flag is given', () => {
  const { root, home } = seedProject();
  writeRepoConfig(root, { 'ttl.default': 30 });
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--json']);
  assert.equal(res.status, 0);
  const days = expiryDays(home);
  assert.ok(days > 29 && days < 31, `expiry ≈ 30 days out (got ${days})`);
  assert.equal(JSON.parse(res.stdout).ttl_source, 'config');
});

test('write leaves a memory permanent when no default is configured', () => {
  const { root, home } = seedProject();
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--json']);
  assert.equal(res.status, 0);
  assert.equal(expiryDays(home), null);
  assert.equal(JSON.parse(res.stdout).ttl_source, 'none');
});

test('write: an explicit --ttl-days outranks the configured default', () => {
  const { root, home } = seedProject();
  writeRepoConfig(root, { 'ttl.default': 30 });
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--ttl-days', '7', '--json']);
  assert.equal(res.status, 0);
  const days = expiryDays(home);
  assert.ok(days > 6 && days < 8, `expiry ≈ 7 days out (got ${days})`);
  assert.equal(JSON.parse(res.stdout).ttl_source, 'flag');
});

test('write: --clear-ttl suppresses the configured default entirely', () => {
  // "Make this permanent" has to mean permanent, not "permanent unless the repo
  // config disagrees" — otherwise there is no way to opt one memory out.
  const { root, home } = seedProject();
  writeRepoConfig(root, { 'ttl.default': 30 });
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--clear-ttl', '--json']);
  assert.equal(res.status, 0);
  assert.equal(expiryDays(home), null);
});

test('write: a scope.defaults ttl_days beats ttl.default for a matching scope', () => {
  const { root, home } = seedProject();
  writeRepoConfig(root, {
    'ttl.default': 90,
    'scope.defaults': { global: { ttl_days: 14 } },
  });
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--json']);
  assert.equal(res.status, 0);
  const days = expiryDays(home);
  assert.ok(days > 13 && days < 15, `expiry ≈ 14 days out (got ${days})`);
});

test('write: scope.defaults ttl_days null keeps that scope permanent under ttl.default', () => {
  const { root, home } = seedProject();
  writeRepoConfig(root, {
    'ttl.default': 30,
    'scope.defaults': { global: { ttl_days: null } },
  });
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--json']);
  assert.equal(res.status, 0);
  assert.equal(expiryDays(home), null);
});

test('write: an out-of-range ttl.default is ignored, and the write still succeeds', () => {
  // A config file is ambient state, not a caller assertion — unlike --ttl-days
  // 999, which is a usage error. It must never break an unrelated write.
  const { root, home } = seedProject();
  writeRepoConfig(root, { 'ttl.default': 999 });
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--json']);
  assert.equal(res.status, 0);
  assert.equal(expiryDays(home), null);
  assert.equal(JSON.parse(res.stdout).ttl_source, 'none');
});

test('write: a malformed .lorekit.json does not break the write', () => {
  const { root, home } = seedProject();
  fs.writeFileSync(path.join(root, '.lorekit.json'), '{ this is not json');
  const res = runWrite(root, home, ['global', 'k', 'v', '--local', '--json']);
  assert.equal(res.status, 0);
  assert.equal(expiryDays(home), null);
});

test('write: the human output names the config as the source of an unrequested TTL', () => {
  const { root, home } = seedProject();
  writeRepoConfig(root, { 'ttl.default': 30 });
  const res = runWrite(root, home, ['global', 'k', 'v', '--local']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /expires\s+in 30 days \(from config\)/);
});
