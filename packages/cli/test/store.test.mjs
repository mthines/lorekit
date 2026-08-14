// Local file store + on-disk format tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serializeEntry, parseEntry, slugify, scopeToDir } from '../src/store/format.mjs';
import { createLocalStore, createTwoTierStore } from '../src/store/local.mjs';

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
    origin_repo: null,
    origin_branch: null,
    origin_commit: null,
    origin_pr: null,
    expires_at: null,
    seen_count: null,
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
  const base = path.join('/store', '.lorekit');
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

test('search accepts a list of terms and OR-matches them in one pass', async () => {
  const store = createLocalStore(tmpDir());
  await store.write({ scope: 'global', key: 'auth-note', value: 'tokens expire' });
  await store.write({ scope: 'global', key: 'db', value: 'use one batched query' });
  await store.write({ scope: 'global', key: 'sky', value: 'the sky is blue' });

  // ANY term matching includes the entry; the tool-failure lookup relies on this.
  const anyOf = await store.search({ q: ['tokens', 'batched'], scopes: ['global'] });
  assert.deepEqual(anyOf.entries.map((e) => e.key).sort(), ['auth-note', 'db']);

  // A list of only empty strings drops to no needles → "return everything", like ''.
  const blank = await store.search({ q: ['', ''], scopes: ['global'] });
  assert.equal(blank.entries.length, 3);
  const none = await store.search({ q: [], scopes: ['global'] });
  assert.equal(none.entries.length, 3);
});

test('search honours walkLimit so the per-prompt walk stays bounded', async () => {
  // The per-prompt hook walks the local store on the user's critical path; an
  // unbounded walk a remote timeout cannot interrupt is the scalability hazard.
  // walkLimit caps matches and stops the walk — later scopes are skipped once it
  // is reached, so the retained hits are the nearest-scope (first-listed) ones.
  // It is named walkLimit, not limit, so it never reaches the remote store's
  // `body.limit` and truncates that hit set pre-ranking.
  const store = createLocalStore(tmpDir());
  for (let i = 0; i < 10; i++) {
    await store.write({ scope: 'repo::o/r', key: `near-${i}`, value: 'deadlock on migrate' });
  }
  await store.write({ scope: 'global', key: 'far', value: 'deadlock on migrate' });

  const capped = await store.search({ q: ['deadlock'], scopes: ['repo::o/r', 'global'], walkLimit: 3 });
  assert.equal(capped.entries.length, 3, 'the walk stopped at walkLimit');
  assert.ok(
    capped.entries.every((e) => e.scope === 'repo::o/r'),
    'the nearest scope filled the cap; the later scope was never walked',
  );

  const unbounded = await store.search({ q: ['deadlock'], scopes: ['repo::o/r', 'global'] });
  assert.equal(unbounded.entries.length, 11, 'omitting walkLimit stays unbounded as before');
});

test('two-tier search honours walkLimit across both tiers', async () => {
  const home = tmpDir();
  const project = tmpDir();
  for (let i = 0; i < 5; i++) {
    await createLocalStore(home).write({ scope: 'global', key: `h${i}`, value: 'timeout retry' });
    await createLocalStore(project).write({ scope: 'repo::o/r', key: `p${i}`, value: 'timeout retry' });
  }
  const store = createTwoTierStore({ home, project });
  const capped = await store.search({ q: ['timeout'], scopes: ['repo::o/r', 'global'], walkLimit: 4 });
  assert.equal(capped.entries.length, 4, 'the merged two-tier result honours the cap');
});

test('two-tier search splits the walkLimit budget so a full project tier cannot starve home', async () => {
  // The per-prompt hot path caps BOTH tiers at walkLimit and then merges
  // project-first. Slicing that merge to walkLimit would hand every slot to the
  // project tier, and `rankLessons` would never see a home-tier lesson at all.
  const home = tmpDir();
  const project = tmpDir();
  for (let i = 0; i < 10; i++) {
    await createLocalStore(project).write({ scope: 'repo::o/r', key: `p${i}`, value: 'timeout retry' });
  }
  for (let i = 0; i < 10; i++) {
    await createLocalStore(home).write({ scope: 'global', key: `h${i}`, value: 'timeout retry' });
  }
  const store = createTwoTierStore({ home, project });
  const walkLimit = 6;

  // PREMISE — the project tier alone over-fills the budget. Without this the
  // assertions below are satisfiable by a project tier that was simply small,
  // and the test would pass against the very slice it exists to rule out.
  const projectOnly = await createLocalStore(project)
    .search({ q: ['timeout'], scopes: ['repo::o/r', 'global'], walkLimit });
  assert.equal(projectOnly.entries.length, walkLimit, 'the project tier fills the cap on its own');

  const hits = await store.search({ q: ['timeout'], scopes: ['repo::o/r', 'global'], walkLimit });
  assert.equal(hits.entries.length, walkLimit, 'the merged result still honours the cap');
  assert.equal(
    hits.entries.filter((e) => e.key.startsWith('h')).length,
    walkLimit / 2,
    'the home tier keeps its half of the budget',
  );
  assert.equal(
    hits.entries.filter((e) => e.key.startsWith('p')).length,
    walkLimit / 2,
    'and the project tier keeps its own half rather than the whole slice',
  );

  // An unused half is handed back: with no home tier the project still fills
  // the cap, so the split never costs a single-tier install any depth.
  const projectHeavy = createTwoTierStore({ home: tmpDir(), project });
  const alone = await projectHeavy.search({ q: ['timeout'], scopes: ['repo::o/r', 'global'], walkLimit });
  assert.equal(alone.entries.length, walkLimit, 'an empty home tier gives its share back to project');
});

test('two-tier search accepts a term list and OR-matches across both tiers', async () => {
  const { home, project } = { home: tmpDir(), project: tmpDir() };
  await createLocalStore(home).write({ scope: 'global', key: 'g', value: 'econnrefused on connect' });
  await createLocalStore(project).write({ scope: 'repo::o/r', key: 'r', value: 'flaky timeout retry' });
  const store = createTwoTierStore({ home, project });

  const hits = await store.search({ q: ['econnrefused', 'timeout'], scopes: ['repo::o/r', 'global'] });
  assert.deepEqual(hits.entries.map((e) => e.key).sort(), ['g', 'r']);
});

test('the store writes into the canonical-scope directory layout', async () => {
  const base = tmpDir();
  const store = createLocalStore(base);
  await store.write({ scope: 'branch::mthines/lorekit::feat/x', key: 'k', value: 'v' });
  const dir = path.join(base, 'branch', 'mthines', 'lorekit', 'feat', 'x');
  assert.ok(fs.existsSync(dir));
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length, 1);
});

test('putEntry upserts verbatim by scope+key, preserving created/updated/archived_at', async () => {
  const store = createLocalStore(tmpDir());
  const entry = {
    scope: 'repo::o/r',
    key: 'k',
    tags: ['t'],
    source_agent: 'aw',
    trigger: 'stuck-loop',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-02-02T00:00:00.000Z',
    archived_at: '2026-03-03T00:00:00.000Z',
    origin_repo: null,
    origin_branch: null,
    origin_commit: null,
    origin_pr: null,
    expires_at: null,
    seen_count: null,
    value: 'preserved body',
  };
  await store.putEntry(entry);
  const back = store.getEntry({ scope: 'repo::o/r', key: 'k' });
  assert.deepEqual(back, entry); // every field verbatim, archived not revived
  // getEntry sees archived; read() hides it.
  assert.equal((await store.read({ scope: 'repo::o/r', key: 'k' })).entry, null);
});

test('two-tier read merges both tiers; project wins on key collision', async () => {
  const home = tmpDir();
  const project = tmpDir(); // exists → opted-in
  const hStore = createLocalStore(home);
  const pStore = createLocalStore(project);
  await hStore.write({ scope: 'repo::o/r', key: 'shared', value: 'home-val' });
  await hStore.write({ scope: 'repo::o/r', key: 'home-only', value: 'h' });
  await pStore.write({ scope: 'repo::o/r', key: 'shared', value: 'project-val' });
  await pStore.write({ scope: 'repo::o/r', key: 'proj-only', value: 'p' });

  const store = createTwoTierStore({ home, project });
  const { entries } = await store.list({ scope: 'repo::o/r' });
  const map = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  assert.equal(entries.length, 3);
  assert.equal(map.shared, 'project-val'); // project shadows home
  assert.equal(map['home-only'], 'h');
  assert.equal(map['proj-only'], 'p');
  assert.equal((await store.read({ scope: 'repo::o/r', key: 'shared' })).entry.value, 'project-val');
});

test('two-tier write-routing: global→home; repo→project when opted-in, else home', async () => {
  const home = tmpDir();
  const project = path.join(tmpDir(), '.lorekit'); // does NOT exist yet → not opted-in
  const store = createTwoTierStore({ home, project });
  assert.equal(store.projectActive(), false);

  // Not opted-in: a repo write lands in home.
  await store.write({ scope: 'repo::o/r', key: 'k1', value: 'v1' });
  assert.equal(createLocalStore(home).getEntry({ scope: 'repo::o/r', key: 'k1' }).value, 'v1');
  // global always → home.
  await store.write({ scope: 'global', key: 'g1', value: 'gv1' });
  assert.equal(createLocalStore(home).getEntry({ scope: 'global', key: 'g1' }).value, 'gv1');

  // Opt in by creating the project dir → repo writes now land in project.
  fs.mkdirSync(project, { recursive: true });
  assert.equal(store.projectActive(), true);
  await store.write({ scope: 'repo::o/r', key: 'k2', value: 'v2' });
  assert.equal(createLocalStore(project).getEntry({ scope: 'repo::o/r', key: 'k2' }).value, 'v2');
  assert.equal(createLocalStore(home).getEntry({ scope: 'repo::o/r', key: 'k2' }), null);
  // global still → home even when opted-in.
  await store.write({ scope: 'global', key: 'g2', value: 'gv2' });
  assert.equal(createLocalStore(home).getEntry({ scope: 'global', key: 'g2' }).value, 'gv2');
});

test('two-tier delete/archive peels the project shadow first, revealing the home copy', async () => {
  // A key present in BOTH tiers is an overlay: the project copy shadows home.
  // delete/archive act on the visible (project) copy only, so one op reveals the
  // home copy rather than destroying it; a second op then removes the home copy.
  // This is conservative by design — a single delete never reaches through and
  // erases the broader, cross-repo home lesson.
  const seed = async () => {
    const home = tmpDir();
    const project = tmpDir(); // exists → opted-in
    await createLocalStore(home).write({ scope: 'repo::o/r', key: 'k', value: 'home-val' });
    await createLocalStore(project).write({ scope: 'repo::o/r', key: 'k', value: 'project-val' });
    return { store: createTwoTierStore({ home, project }), home };
  };

  // Force delete: peel project, reveal home, then delete home.
  {
    const { store, home } = await seed();
    assert.equal((await store.read({ scope: 'repo::o/r', key: 'k' })).entry.value, 'project-val');
    await store.delete({ scope: 'repo::o/r', key: 'k', force: true });
    assert.equal((await store.read({ scope: 'repo::o/r', key: 'k' })).entry.value, 'home-val');
    // Home copy is untouched by the first delete.
    assert.equal(createLocalStore(home).getEntry({ scope: 'repo::o/r', key: 'k' }).value, 'home-val');
    await store.delete({ scope: 'repo::o/r', key: 'k', force: true });
    assert.equal((await store.read({ scope: 'repo::o/r', key: 'k' })).entry, null);
  }

  // Soft archive: same peel-back — archiving the project copy reveals home.
  {
    const { store } = await seed();
    await store.archive({ scope: 'repo::o/r', key: 'k' });
    assert.equal((await store.read({ scope: 'repo::o/r', key: 'k' })).entry.value, 'home-val');
    const { entries } = await store.list({ scope: 'repo::o/r' });
    assert.deepEqual(entries.map((e) => e.value), ['home-val']); // list mirrors read
  }
});

// ── Provenance (origin_*) round-trip and last-known-wins upsert ───────────────

test('origin fields round-trip through the on-disk format', () => {
  const entry = {
    scope: 'global',
    key: 'aw-lessons::origin',
    tags: [],
    source_agent: 'aw',
    trigger: null,
    created: '2026-07-24T10:00:00.000Z',
    updated: '2026-07-24T10:00:00.000Z',
    archived_at: null,
    origin_repo: 'mthines/lorekit',
    origin_branch: 'feat/Origin-Provenance',
    origin_commit: 'a1b2c3d4e5f6',
    origin_pr: 482,
    expires_at: null,
    seen_count: null,
    value: 'A lesson learned in a pull request.',
  };
  assert.deepEqual(parseEntry(serializeEntry(entry)), entry);
});

test('an entry written before origin existed still parses (fields absent)', () => {
  const legacy = [
    '---',
    'scope: "global"',
    'key: "legacy"',
    'tags: []',
    'source_agent: null',
    'trigger: null',
    'created: "2026-01-01T00:00:00.000Z"',
    'updated: "2026-01-01T00:00:00.000Z"',
    'archived_at: null',
    '---',
    'Legacy body.',
  ].join('\n');
  const parsed = parseEntry(legacy);
  assert.equal(parsed.key, 'legacy');
  assert.equal(parsed.origin_pr, undefined);
});

test('local write stores origin and keeps the last KNOWN value per field', async () => {
  const store = createLocalStore(tmpDir());
  await store.write({
    scope: 'global',
    key: 'k',
    value: 'v1',
    origin_repo: 'mthines/lorekit',
    origin_branch: 'feat/a',
    origin_commit: 'abc1234',
    origin_pr: 12,
  });

  // A later write from a machine with no PR/commit context must not erase what
  // the first write recorded — mirrors the hosted memory_write coalesce rule.
  const { entry } = await store.write({
    scope: 'global',
    key: 'k',
    value: 'v2',
    origin_branch: 'feat/b',
  });

  assert.equal(entry.value, 'v2');
  assert.equal(entry.origin_branch, 'feat/b');
  assert.equal(entry.origin_repo, 'mthines/lorekit');
  assert.equal(entry.origin_commit, 'abc1234');
  assert.equal(entry.origin_pr, 12);
});

test('local write leaves origin null when none is supplied', async () => {
  const store = createLocalStore(tmpDir());
  const { entry } = await store.write({ scope: 'global', key: 'k', value: 'v' });
  assert.equal(entry.origin_repo, null);
  assert.equal(entry.origin_pr, null);
});
