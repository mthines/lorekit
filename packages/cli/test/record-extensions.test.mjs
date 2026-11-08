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
import { createLocalStore } from '../src/store/local.mjs';
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
