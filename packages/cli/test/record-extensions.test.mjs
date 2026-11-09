// Record extensions on the local store (migration 00119's offline twin):
//   • stable id   — minted on the first write, kept on every rewrite
//   • lossless    — a frontmatter field this version does not know survives a rewrite
//   • attributes  — merged on update, a null value removes a key
//   • content     — application/json must parse
//   • write flags — `lorekit write --attributes/--content-type/--supersedes`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalStore, createTwoTierStore } from '../src/store/local.mjs';
import { parseEntry } from '../src/store/format.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function filesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true })
    .map((rel) => path.join(dir, rel))
    .filter((f) => f.endsWith('.md') && fs.statSync(f).isFile());
}

function readOnly(dir) {
  const files = filesUnder(dir);
  assert.equal(files.length, 1, `expected one record file, found ${files.length}`);
  return { file: files[0], entry: parseEntry(fs.readFileSync(files[0], 'utf8')) };
}

test('stable id: minted on the first write and kept on rewrite and archive', async () => {
  const dir = tmp('lk-rx-id-');
  const store = createLocalStore(dir);
  const first = await store.write({ scope: 'global', key: 'k', value: 'one' });
  assert.match(first.entry.id, UUID_RE);
  const second = await store.write({ scope: 'global', key: 'k', value: 'two' });
  assert.equal(second.entry.id, first.entry.id);
  await store.archive({ scope: 'global', key: 'k' });
  assert.equal(readOnly(dir).entry.id, first.entry.id);
  // A different key gets a different id.
  const other = await store.write({ scope: 'global', key: 'other', value: 'x' });
  assert.notEqual(other.entry.id, first.entry.id);
});

test('stable id: an entry written before ids existed gets one on its next write', async () => {
  const dir = tmp('lk-rx-legacy-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'k', value: 'v' });
  const { file } = readOnly(dir);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^id: .*\n/m, ''));
  const again = await store.write({ scope: 'global', key: 'k', value: 'v2' });
  assert.match(again.entry.id, UUID_RE);
});

test('lossless: an unknown frontmatter field survives a rewrite, an archive and a putEntry', async () => {
  const dir = tmp('lk-rx-lossless-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'k', value: 'v' });
  const { file } = readOnly(dir);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n---\n/, '\nx_review: {"by":"alice"}\n---\n'));

  await store.write({ scope: 'global', key: 'k', value: 'v2' });
  assert.deepEqual(readOnly(dir).entry.x_review, { by: 'alice' });

  await store.archive({ scope: 'global', key: 'k' });
  assert.deepEqual(readOnly(dir).entry.x_review, { by: 'alice' });

  await store.putEntry(readOnly(dir).entry);
  const { entry } = readOnly(dir);
  assert.deepEqual(entry.x_review, { by: 'alice' });
  assert.equal(entry.value, 'v2');
});

test('attributes merge on update and a null value removes a key', async () => {
  const dir = tmp('lk-rx-attrs-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'k', value: 'v', attributes: { 'ci.run_url': 'https://ci/1', 'vcs.pr': 7 } });
  await store.write({ scope: 'global', key: 'k', value: 'v2', attributes: { 'vcs.pr': null, team: 'core' } });
  await store.write({ scope: 'global', key: 'k', value: 'v3' });
  assert.deepEqual(readOnly(dir).entry.attributes, { 'ci.run_url': 'https://ci/1', team: 'core' });
});

test('content_type: application/json must parse, also when only the value changes', async () => {
  const dir = tmp('lk-rx-ct-');
  const store = createLocalStore(dir);
  const bad = await store.write({ scope: 'global', key: 'k', value: 'nope', content_type: 'application/json' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /valid JSON/);
  const ok = await store.write({ scope: 'global', key: 'k', value: '{"a":1}', content_type: 'application/json' });
  assert.equal(ok.ok, true);
  const drift = await store.write({ scope: 'global', key: 'k', value: 'not json any more' });
  assert.equal(drift.ok, false);
  const unknown = await store.write({ scope: 'global', key: 'z', value: 'v', content_type: 'text/html' });
  assert.equal(unknown.ok, false);
});

test('write flags: --attributes, --content-type and --supersedes reach the stored record', () => {
  const root = tmp('lk-rx-cli-root-');
  const home = tmp('lk-rx-cli-home-');
  const env = { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home, LOREKIT_HOME: home, LOREKIT_TELEMETRY: '0' };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  const target = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
  const res = spawnSync(process.execPath, [
    BIN, 'write', 'global::ci-result', '{"passed":true}', '--local', '--no-origin',
    '--attributes', '{"ci.run_url":"https://ci.example/1","vcs.pr":482}',
    '--content-type', 'application/json',
    '--supersedes', target,
    '--dir', root,
  ], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);

  const files = [...filesUnder(root), ...filesUnder(home)];
  const entries = files.map((f) => parseEntry(fs.readFileSync(f, 'utf8'))).filter((e) => e?.key === 'ci-result');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].attributes, { 'ci.run_url': 'https://ci.example/1', 'vcs.pr': 482 });
  assert.equal(entries[0].content_type, 'application/json');
  assert.equal(entries[0].supersedes, target);

  const bad = spawnSync(process.execPath, [
    BIN, 'write', 'global::x', 'v', '--local', '--no-origin', '--attributes', 'not-json', '--dir', root,
  ], { encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--attributes must be a JSON object/);
});

test('write flags: a bare --supersedes or --content-type is a usage error, not a silent no-op', () => {
  const root = tmp('lk-rx-cli-bare-root-');
  const home = tmp('lk-rx-cli-bare-home-');
  const env = { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home, LOREKIT_HOME: home, LOREKIT_TELEMETRY: '0' };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  // `--attributes` and `--origin-pr` already refuse a bad explicit value; these two
  // must not report "memory written" for a flag the user believes they set.
  for (const flag of ['--supersedes', '--content-type']) {
    const res = spawnSync(process.execPath, [
      BIN, 'write', 'global::bare', 'v', '--local', '--no-origin', '--dir', root, flag,
    ], { encoding: 'utf8', env });
    assert.equal(res.status, 1, `${flag} with no value must fail, got ${res.status}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, new RegExp(`${flag} needs a value`));
  }
  // A `global::` local write lands in the home store, a project one under the root:
  // look in both, or the check passes even when a record was written.
  const filesUnder = (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name))
    : []);
  assert.deepEqual([...filesUnder(root), ...filesUnder(home)], [], 'a refused write must leave no record');
});

test('validation parity: the local store rejects what the hosted store rejects', async () => {
  const dir = tmp('lk-rx-parity-');
  const store = createLocalStore(dir);
  const bad = [
    [{ attributes: { 'CI.Run': 'x' } }, /attribute key must be lowercase/],
    [{ attributes: { k: 'x'.repeat(1025) } }, /<= 1024 characters/],
    [{ supersedes: 'not-a-uuid' }, /supersedes must be a memory id/],
    // A non-string is rejected, not silently dropped, as the hosted parser does.
    [{ supersedes: 42 }, /supersedes must be a memory id/],
    [{ content_type: 123 }, /content_type must be a string/],
  ];
  for (const [fields, message] of bad) {
    const res = await store.write({ scope: 'global', key: 'k', value: 'v', ...fields });
    assert.equal(res.ok, false);
    assert.match(res.error, message);
  }
  // Content types and ids are normalised lowercase, as the server does.
  const id = '6F1C2A5E-3B4D-4E8F-9A0B-1C2D3E4F5A6B';
  const ok = await store.write({
    scope: 'global', key: 'k', value: '{}', content_type: 'Application/JSON', supersedes: id,
  });
  assert.equal(ok.entry.content_type, 'application/json');
  assert.equal(ok.entry.supersedes, id.toLowerCase());
  // The 32-key cap holds on the merged map, not only on one write.
  const half = (from) => Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${from + i}`, i]));
  assert.equal((await store.write({ scope: 'global', key: 'cap', value: 'v', attributes: half(0) })).ok, true);
  const over = await store.write({ scope: 'global', key: 'cap', value: 'v', attributes: half(100) });
  assert.equal(over.ok, false);
  assert.match(over.error, /<= 32 keys/);
  // A record cannot supersede itself.
  const self = await store.write({ scope: 'global', key: 'cap', value: 'v', supersedes: ok.entry.id });
  assert.equal(self.ok, true, 'a different record may be superseded');
  const own = (await store.write({ scope: 'global', key: 'cap', value: 'v' })).entry.id;
  const loop = await store.write({ scope: 'global', key: 'cap', value: 'v', supersedes: own });
  assert.equal(loop.ok, false);
  assert.match(loop.error, /cannot supersede itself/);
});

test('revive: a write to an archived key does not inherit its record extensions', async () => {
  const dir = tmp('lk-rx-revive-');
  const store = createLocalStore(dir);
  await store.write({
    scope: 'global', key: 'k', value: '{}', content_type: 'application/json', attributes: { 'vcs.pr': 1 },
  });
  await store.archive({ scope: 'global', key: 'k' });
  const revived = await store.write({ scope: 'global', key: 'k', value: 'plain markdown' });
  assert.equal(revived.ok, true, revived.error);
  assert.equal(revived.entry.content_type, null);
  assert.deepEqual(revived.entry.attributes, {});
});

test('revive: a revived key is a new record that may supersede its archived predecessor', async () => {
  const dir = tmp('lk-rx-revive-id-');
  const store = createLocalStore(dir);
  const first = await store.write({ scope: 'global', key: 'k', value: 'one' });
  await store.archive({ scope: 'global', key: 'k' });
  const revived = await store.write({ scope: 'global', key: 'k', value: 'two', supersedes: first.entry.id });
  assert.equal(revived.ok, true, revived.error);
  assert.notEqual(revived.entry.id, first.entry.id);
  assert.equal(revived.entry.supersedes, first.entry.id);
});

// ── Version + optimistic concurrency + superseded_by (00120's offline twin) ──

function cliEnv(home) {
  const env = { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home, LOREKIT_HOME: home, LOREKIT_TELEMETRY: '0' };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  return env;
}

test('version: starts at 1 and bumps only on a content change', async () => {
  const store = createLocalStore(tmp('lk-ver-bump-'));
  const w = (args) => store.write({ scope: 'global', key: 'k', ...args });
  assert.equal((await w({ value: 'one' })).entry.version, 1);
  // An identical rewrite is not a change.
  assert.equal((await w({ value: 'one' })).entry.version, 1);
  assert.equal((await w({ value: 'two' })).entry.version, 2);
  assert.equal((await w({ value: 'two', tags: ['a'] })).entry.version, 3);
  assert.equal((await w({ value: 'two', tags: ['a'], attributes: { 'x.y': 1 } })).entry.version, 4);
  // The same attribute again merges to the same map: no change.
  assert.equal((await w({ value: 'two', tags: ['a'], attributes: { 'x.y': 1 } })).entry.version, 4);
  // text/markdown is what null means, so naming it is not a change.
  assert.equal((await w({ value: 'two', tags: ['a'], content_type: 'text/markdown' })).entry.version, 4);
  const target = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
  assert.equal((await w({ value: 'two', tags: ['a'], supersedes: target })).entry.version, 5);
  // Re-naming the same link, TTL, provenance and taxonomy are not content.
  assert.equal((await w({ value: 'two', tags: ['a'], supersedes: target })).entry.version, 5);
  assert.equal((await w({ value: 'two', tags: ['a'], ttl_days: 7 })).entry.version, 5);
  assert.equal((await w({ value: 'two', tags: ['a'], origin_repo: 'o/r', kind: 'lesson' })).entry.version, 5);
  // Archive/restore does not bump; a write to an archived key starts at 1.
  await store.archive({ scope: 'global', key: 'k' });
  await store.restore({ scope: 'global', key: 'k' });
  assert.equal((await store.read({ scope: 'global', key: 'k' })).entry.version, 5);
  await store.archive({ scope: 'global', key: 'k' });
  assert.equal((await w({ value: 'reborn' })).entry.version, 1);
});

test('version: a file written before the column existed reads, and rewrites, from 1', async () => {
  const dir = tmp('lk-ver-legacy-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'k', value: 'v' });
  const { file } = readOnly(dir);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^version: .*\n/m, ''));
  assert.equal((await store.read({ scope: 'global', key: 'k' })).entry.version, 1);
  assert.equal((await store.list({ scope: 'global' })).entries[0].version, 1);
  assert.equal((await store.write({ scope: 'global', key: 'k', value: 'v2' })).entry.version, 2);
});

test('expected_version: a match writes, a mismatch refuses and writes nothing', async () => {
  const dir = tmp('lk-ver-cas-');
  const store = createLocalStore(dir);
  // 0 = must not exist yet.
  assert.equal((await store.write({ scope: 'global', key: 'k', value: 'a', expected_version: 0 })).ok, true);
  const again = await store.write({ scope: 'global', key: 'k', value: 'b', expected_version: 0 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'version_conflict');
  assert.equal(again.current_version, 1);
  assert.match(again.error, /^version_conflict: expected_version 0 does not match the stored version 1/);
  assert.equal(readOnly(dir).entry.value, 'a');

  assert.equal((await store.write({ scope: 'global', key: 'k', value: 'b', expected_version: 1 })).entry.version, 2);
  const stale = await store.write({ scope: 'global', key: 'k', value: 'c', expected_version: 1 });
  assert.equal(stale.code, 'version_conflict');
  assert.equal(stale.current_version, 2);
  assert.equal(readOnly(dir).entry.value, 'b');

  // A key that does not exist is at version 0.
  const missing = await store.write({ scope: 'global', key: 'nope', value: 'x', expected_version: 3 });
  assert.equal(missing.current_version, 0);
  assert.match(missing.error, /the memory does not exist/);
  // An archived record is not live, so it is absent too.
  await store.archive({ scope: 'global', key: 'k' });
  assert.equal((await store.write({ scope: 'global', key: 'k', value: 'new', expected_version: 0 })).entry.version, 1);
  // Malformed values are refused.
  for (const bad of [-1, 1.5, '2']) {
    const r = await store.write({ scope: 'global', key: 'z', value: 'x', expected_version: bad });
    assert.equal(r.ok, false);
    assert.match(r.error, /expected_version must be a non-negative integer/);
  }
});

test('expected_version: an expired record counts as absent, as it does for reads', async () => {
  const dir = tmp('lk-ver-exp-');
  const store = createLocalStore(dir);
  await store.write({ scope: 'global', key: 'k', value: 'one' });
  await store.write({ scope: 'global', key: 'k', value: 'two' });
  // Expire it on disk: every read now hides it.
  const { file } = readOnly(dir);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace(/^expires_at: .*\n/m, '')
    .replace(/^version: /m, `expires_at: ${new Date(Date.now() - 60_000).toISOString()}\nversion: `));
  assert.equal((await store.read({ scope: 'global', key: 'k' })).entry, null);
  // The version it last had is refused — a reader sees nothing, version 0 …
  const stale = await store.write({ scope: 'global', key: 'k', value: 'x', expected_version: 2 });
  assert.equal(stale.code, 'version_conflict');
  assert.equal(stale.current_version, 0);
  // … and 0 lands. The same record is rewritten in place and, as on the
  // server, its version continues counting rather than restarting at 1.
  const ok = await store.write({ scope: 'global', key: 'k', value: 'three', expected_version: 0, clear_ttl: true });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.entry.version, 3);
  assert.equal(readOnly(dir).entry.value, 'three');
  // Live again, so 0 now conflicts at its version.
  assert.equal((await store.write({ scope: 'global', key: 'k', value: 'y', expected_version: 0 })).current_version, 3);
});

test('expected_version: reviving an expired record with no TTL named makes it live again', async () => {
  const dir = tmp('lk-ver-exp-ttl-');
  const store = createLocalStore(dir);
  const expire = () => {
    const { file } = readOnly(dir);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace(/^expires_at: .*\n/m, '')
      .replace(/^version: /m, `expires_at: ${new Date(Date.now() - 60_000).toISOString()}\nversion: `));
  };
  await store.write({ scope: 'global', key: 'k', value: 'one' });
  expire();
  // No ttl_days, no clear_ttl: keeping the past expires_at would leave the
  // write hidden (and purgeable). It is cleared, as a fresh record gets.
  const ok = await store.write({ scope: 'global', key: 'k', value: 'two', expected_version: 0 });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.entry.expires_at, null);
  assert.equal((await store.read({ scope: 'global', key: 'k' })).entry.value, 'two');
  // A TTL named on the revive is honoured.
  expire();
  const ttl = await store.write({ scope: 'global', key: 'k', value: 'three', expected_version: 0, ttl_days: 7 });
  assert.ok(Date.parse(ttl.entry.expires_at) > Date.now());
  // Scope of the fix: a write without expected_version keeps the stored TTL.
  expire();
  const plain = await store.write({ scope: 'global', key: 'k', value: 'four' });
  assert.ok(Date.parse(plain.entry.expires_at) <= Date.now());
});

test('expected_version: two tiers check against the record a read resolves, and continue its version', async () => {
  const home = tmp('lk-ver-2t-home-');
  const project = path.join(tmp('lk-ver-2t-proj-'), '.lorekit');
  const scope = 'repo::o/r';
  // The key lives only in the home tier, at version 2 (written before the
  // project tier existed).
  const homeOnly = createTwoTierStore({ home, project });
  await homeOnly.write({ scope, key: 'k', value: 'one' });
  assert.equal((await homeOnly.write({ scope, key: 'k', value: 'two' })).entry.version, 2);
  // Opt the project tier in: writes now target it, reads fall through to home.
  fs.mkdirSync(project, { recursive: true });
  const store = createTwoTierStore({ home, project });
  assert.equal((await store.read({ scope, key: 'k' })).entry.version, 2);
  // 0 is refused — a reader sees the home record — and reports its version.
  const absent = await store.write({ scope, key: 'k', value: 'x', expected_version: 0 });
  assert.equal(absent.code, 'version_conflict');
  assert.equal(absent.current_version, 2);
  // The version the reader saw is accepted, and the project copy that now
  // shadows home continues it rather than restarting at 1.
  const ok = await store.write({ scope, key: 'k', value: 'three', expected_version: 2 });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.entry.version, 3);
  assert.equal(readOnly(project).entry.value, 'three');
  assert.equal(readOnly(home).entry.version, 2);
  const read = (await store.read({ scope, key: 'k' })).entry;
  assert.equal(read.value, 'three');
  assert.equal(read.version, 3);
  // From here the project copy is the one checked.
  assert.equal((await store.write({ scope, key: 'k', value: 'y', expected_version: 2 })).current_version, 3);
  // Identical content copied up does not bump: a fresh home-only key at v1,
  // re-written unchanged through the project tier, stays at 1.
  await homeOnly.home.write({ scope, key: 'same', value: 'v', tags: ['t'] });
  assert.equal((await store.write({ scope, key: 'same', value: 'v', tags: ['t'], expected_version: 1 })).entry.version, 1);
});

test('expected_version: an expired project copy under a live home copy never moves the version backwards', async () => {
  const home = tmp('lk-ver-2t-max-home-');
  const project = path.join(tmp('lk-ver-2t-max-proj-'), '.lorekit');
  const scope = 'repo::o/r';
  fs.mkdirSync(project, { recursive: true });
  const store = createTwoTierStore({ home, project });
  // Project copy at v2, then expired on disk.
  await store.write({ scope, key: 'k', value: 'p1' });
  await store.write({ scope, key: 'k', value: 'p2' });
  const { file } = readOnly(project);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace(/^expires_at: .*\n/m, '')
    .replace(/^version: /m, `expires_at: ${new Date(Date.now() - 60_000).toISOString()}\nversion: `));
  // Home copy live at v5.
  for (const v of ['h1', 'h2', 'h3', 'h4', 'h5']) await store.home.write({ scope, key: 'k', value: v });
  const seen = (await store.read({ scope, key: 'k' })).entry;
  assert.equal(seen.version, 5);
  assert.equal(seen.value, 'h5');
  const ok = await store.write({ scope, key: 'k', value: 'next', expected_version: 5 });
  assert.equal(ok.ok, true, ok.error);
  assert.ok(ok.entry.version >= 6, `version went backwards: ${ok.entry.version}`);
  assert.equal(ok.entry.version, 6);
  const read = (await store.read({ scope, key: 'k' })).entry;
  assert.equal(read.value, 'next');
  assert.equal(read.version, 6);
  // Identical content to what the reader saw does not bump, and still never drops below it.
  const { entry: same } = await store.write({ scope, key: 'k', value: 'next', expected_version: 6 });
  assert.equal(same.version, 6);
});

test('superseded_by: read and readMany name the live records that supersede this one', async () => {
  const store = createLocalStore(tmp('lk-ver-sby-'));
  const old = (await store.write({ scope: 'global', key: 'old', value: 'v' })).entry;
  // No successor: the field is omitted.
  assert.equal('superseded_by' in (await store.read({ scope: 'global', key: 'old' })).entry, false);
  const a = (await store.write({ scope: 'repo::o/r', key: 'new-a', value: 'v', supersedes: old.id })).entry;
  await new Promise((r) => setTimeout(r, 5));
  const b = (await store.write({ scope: 'global', key: 'new-b', value: 'v', supersedes: old.id })).entry;
  const read = (await store.read({ scope: 'global', key: 'old' })).entry;
  assert.deepEqual(read.superseded_by, [b.id, a.id], 'newest first');
  assert.deepEqual((await store.read({ key: 'old' })).entry.superseded_by, [b.id, a.id]);
  const many = await store.readMany([{ scope: 'global', key: 'old' }, { scope: 'global', key: 'new-b' }]);
  assert.deepEqual(many.entries[0].superseded_by, [b.id, a.id]);
  assert.equal('superseded_by' in many.entries[1], false);
  // An archived successor no longer counts.
  await store.archive({ scope: 'repo::o/r', key: 'new-a' });
  assert.deepEqual((await store.read({ scope: 'global', key: 'old' })).entry.superseded_by, [b.id]);
});

test('write flags: --expected-version guards the write and a conflict exits non-zero', () => {
  const root = tmp('lk-ver-cli-root-');
  const home = tmp('lk-ver-cli-home-');
  const env = cliEnv(home);
  const run = (...extra) => spawnSync(process.execPath, [
    BIN, 'write', 'global::cas', ...extra, '--local', '--no-origin', '--dir', root,
  ], { encoding: 'utf8', env });

  const first = run('one', '--expected-version', '0', '--json');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).version, 1);

  const conflict = run('two', '--expected-version', '0');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /version conflict — global::cas is at version 1, not 0\. Nothing was written\./);

  const ok = run('two', '--expected-version', '1', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).version, 2);

  for (const bad of [['--expected-version'], ['--expected-version', '1.5'], ['--expected-version', 'x']]) {
    const res = run('three', ...bad);
    assert.equal(res.status, 1, `${bad.join(' ')} must fail`);
    assert.match(res.stderr, /--expected-version must be a non-negative integer/);
  }

  const show = spawnSync(process.execPath, [BIN, 'show', 'global::cas', '--local', '--json', '--dir', root], { encoding: 'utf8', env });
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).offline.record.version, 2);
});
