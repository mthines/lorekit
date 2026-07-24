// Local file store + on-disk format tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEntry, parseEntry, slugify, scopeToDir } from '../src/store/format.mjs';
import { createLocalStore } from '../src/store/local.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-store-'));
}

test('serializeEntry / parseEntry round-trip', () => {
  const entry = {
    scope: 'repo::mthines/lorekit',
    key: 'aw-lessons::foo-bar',
    tags: ['skill::aw-lessons', 'type::procedural'],
    source_agent: 'aw',
    trigger: 'stuck-loop',
    created: '2026-07-24T10:00:00.000Z',
    updated: '2026-07-24T10:00:00.000Z',
    archived_at: null,
    value: 'First line of the lesson.\nSecond line with details.',
  };
  const parsed = parseEntry(serializeEntry(entry));
  assert.deepEqual(parsed, entry);
});

test('serialized frontmatter is JSON-valued (greppable / YAML-subset)', () => {
  const text = serializeEntry({
    scope: 'global',
    key: 'k',
    tags: ['a'],
    source_agent: null,
    trigger: null,
    created: '2026-07-24T00:00:00.000Z',
    updated: '2026-07-24T00:00:00.000Z',
    archived_at: null,
    value: 'body',
  });
  assert.match(text, /^---\n/);
  assert.match(text, /\nkey: "k"\n/);
  assert.match(text, /\ntags: \["a"\]\n/);
  assert.match(text, /\narchived_at: null\n/);
  assert.match(text, /\n---\nbody\n$/);
});

test('parseEntry returns null when there is no frontmatter', () => {
  assert.equal(parseEntry('just some text'), null);
});

test('slugify is filesystem-safe and bounded', () => {
  assert.equal(slugify('aw-lessons::Foo Bar!'), 'aw-lessons-foo-bar');
  assert.equal(slugify('::::'), 'entry');
  assert.equal(slugify('a'.repeat(200)).length, 80);
});

test('scopeToDir maps each canonical scope to its layout', () => {
  const base = '/store';
  assert.equal(scopeToDir(base, 'global'), path.join(base, 'global'));
  assert.equal(scopeToDir(base, 'repo::mthines/lorekit'), path.join(base, 'repo', 'mthines', 'lorekit'));
  assert.equal(
    scopeToDir(base, 'branch::mthines/lorekit::feat/x'),
    path.join(base, 'branch', 'mthines', 'lorekit', 'feat', 'x'),
  );
});

test('scopeToDir neutralizes ".." segments so a crafted scope cannot escape the store', () => {
  const base = path.join('/store', '.lore');
  const escapes = [
    'repo::../../etc/x',
    'branch::../..::../..',
    'branch::o/r::../../../evil',
    'project::..',
  ];
  for (const scope of escapes) {
    const dir = scopeToDir(base, scope);
    const rel = path.relative(base, dir);
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `${scope} escaped: ${dir}`);
  }
});

test('write is an upsert by scope+key that preserves created and refreshes updated', async () => {
  const store = createLocalStore(tmpDir());
  const scope = 'global';
  const a = await store.write({ scope, key: 'k1', value: 'v1', tags: ['t'] });
  assert.equal(a.ok, true);
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.write({ scope, key: 'k1', value: 'v2' });
  assert.equal(b.entry.created, a.entry.created); // created preserved
  assert.notEqual(b.entry.updated, a.entry.created); // updated moved forward

  const { entries } = await store.list({ scope });
  assert.equal(entries.length, 1); // upsert, not append
  assert.equal(entries[0].value, 'v2');
});

test('list is newest-first and filters by tag; archived is hidden', async () => {
  const store = createLocalStore(tmpDir());
  const scope = 'repo::o/r';
  await store.write({ scope, key: 'old', value: 'a', tags: ['x'] });
  await new Promise((r) => setTimeout(r, 5));
  await store.write({ scope, key: 'new', value: 'b', tags: ['x', 'y'] });

  const all = await store.list({ scope });
  assert.deepEqual(all.entries.map((e) => e.key), ['new', 'old']); // newest first

  const tagged = await store.list({ scope, tags: ['y'] });
  assert.deepEqual(tagged.entries.map((e) => e.key), ['new']);

  await store.archive({ scope, key: 'new' });
  const afterArchive = await store.list({ scope });
  assert.deepEqual(afterArchive.entries.map((e) => e.key), ['old']);
  assert.equal((await store.read({ scope, key: 'new' })).entry, null); // hidden from read
});

test('delete force removes the file; soft delete archives and restore revives', async () => {
  const store = createLocalStore(tmpDir());
  const scope = 'global';
  await store.write({ scope, key: 'k', value: 'v' });

  await store.delete({ scope, key: 'k' }); // soft
  assert.equal((await store.read({ scope, key: 'k' })).entry, null);
  await store.restore({ scope, key: 'k' });
  assert.equal((await store.read({ scope, key: 'k' })).entry.value, 'v');

  const del = await store.delete({ scope, key: 'k', force: true });
  assert.equal(del.deleted, true);
  assert.deepEqual((await store.list({ scope })).entries, []);
});

test('search matches key, tags, and body across scopes', async () => {
  const store = createLocalStore(tmpDir());
  await store.write({ scope: 'global', key: 'auth-note', value: 'tokens expire', tags: ['security'] });
  await store.write({ scope: 'repo::o/r', key: 'db', value: 'use one batched query', tags: ['perf'] });

  const byBody = await store.search({ q: 'batched', scopes: ['global', 'repo::o/r'] });
  assert.deepEqual(byBody.entries.map((e) => e.key), ['db']);

  const byTag = await store.search({ q: 'security', scopes: ['global', 'repo::o/r'] });
  assert.deepEqual(byTag.entries.map((e) => e.key), ['auth-note']);

  const empty = await store.search({ q: '', scopes: ['global'] });
  assert.equal(empty.entries.length, 1); // empty query returns all in scope
});

test('the store writes into the canonical-scope directory layout', async () => {
  const base = tmpDir();
  const store = createLocalStore(base);
  await store.write({ scope: 'branch::mthines/lorekit::feat/x', key: 'k', value: 'v' });
  const dir = path.join(base, 'branch', 'mthines', 'lorekit', 'feat', 'x');
  assert.ok(fs.existsSync(dir));
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length, 1);
});
