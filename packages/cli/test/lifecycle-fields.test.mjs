// Lifecycle fields on `list --json` entries and `dedupe --json` members.
//
// A grooming pass judges each lesson on how often it recurred (`seen_count`),
// when it expires, and whether agents still read or open it. The hosted list
// already returns those columns; these tests pin that the CLI's view row and
// every dedupe cluster member carry them, additively, in both stores' shapes.
// Test names carry the acceptance-criterion id their check selects on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeEntry,
  clusterDuplicates,
  clusterDuplicatesBlocked,
  clusterByKeyPattern,
} from '../src/shared/lessons-view.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

const LIFECYCLE = ['seen_count', 'expires_at', 'read_count', 'opened_count', 'last_read_at', 'last_opened_at'];
const MEMBER_FIELDS = [...LIFECYCLE, 'created', 'updated', 'tags', 'version', 'preview'];
const EXISTING_ENTRY_KEYS = [
  'scope', 'key', 'value', 'updated', 'created', 'tags', 'kind', 'host',
  'source_agent', 'trigger', 'origin_repo', 'origin_branch', 'origin_pr', 'version',
];

// A row shaped like the hosted `GET /memories` response (`lorekit_memory_list`).
function remoteRow(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    scope: 'repo::acme/web',
    key: 'aw-lessons::flaky-cache',
    value: 'the build cache is flaky on windows ci runners',
    tags: ['loop::aw-lessons'],
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-20T10:00:00.000Z',
    expires_at: '2027-01-01T00:00:00.000Z',
    seen_count: 4,
    read_count: 17,
    opened_count: 3,
    last_read_at: '2026-11-01T09:00:00.000Z',
    last_opened_at: '2026-10-15T09:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

test('AC-1: normalizeEntry carries the six lifecycle values from a remote row', () => {
  const e = normalizeEntry(remoteRow());
  assert.equal(e.seen_count, 4);
  assert.equal(e.expires_at, '2027-01-01T00:00:00.000Z');
  assert.equal(e.read_count, 17);
  assert.equal(e.opened_count, 3);
  assert.equal(e.last_read_at, '2026-11-01T09:00:00.000Z');
  assert.equal(e.last_opened_at, '2026-10-15T09:00:00.000Z');
});

test('AC-1: normalizeEntry keeps every existing key with its existing value', () => {
  const e = normalizeEntry(remoteRow());
  for (const k of EXISTING_ENTRY_KEYS) assert.ok(k in e, `missing existing key ${k}`);
  assert.equal(e.updated, '2026-07-20T10:00:00.000Z');
  assert.equal(e.created, '2026-07-01T10:00:00.000Z');
  assert.equal(e.version, 2);
  assert.deepEqual(e.tags, ['loop::aw-lessons']);
});

test('AC-2: a remote row without the columns reports each lifecycle field as null', () => {
  const row = remoteRow();
  for (const k of LIFECYCLE) delete row[k];
  const e = normalizeEntry(row);
  for (const k of LIFECYCLE) assert.strictEqual(e[k], null, `${k} should be null`);
});

test('AC-2: a local-store row keeps seen_count and expires_at, read counters are null', () => {
  // The local store's frontmatter vocabulary: `updated`/`created`, no read counters.
  const e = normalizeEntry({
    scope: 'global',
    key: 'cache-a',
    value: 'v',
    tags: [],
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    seen_count: 2,
    expires_at: '2026-12-31T00:00:00.000Z',
  });
  assert.equal(e.seen_count, 2);
  assert.equal(e.expires_at, '2026-12-31T00:00:00.000Z');
  for (const k of ['read_count', 'opened_count', 'last_read_at', 'last_opened_at']) {
    assert.strictEqual(e[k], null, `${k} should be null`);
  }
});

test('AC-2: a bare row reports all six lifecycle fields as null, never undefined', () => {
  const e = normalizeEntry({ scope: 'global', key: 'k', value: 'v' });
  for (const k of LIFECYCLE) assert.strictEqual(e[k], null, `${k} should be null`);
});

function duplicatePair() {
  return [
    normalizeEntry(remoteRow()),
    normalizeEntry(
      remoteRow({
        scope: 'global',
        key: 'aw-lessons::flaky-cache-2',
        value: 'the build cache is flaky on windows ci runners sometimes',
        seen_count: 1,
        read_count: 0,
        opened_count: 0,
        last_read_at: null,
        last_opened_at: null,
      }),
    ),
  ];
}

function assertMember(m, expected) {
  for (const k of MEMBER_FIELDS) assert.ok(k in m, `member missing ${k}`);
  assert.equal(m.scope, expected.scope);
  assert.equal(m.key, expected.key);
  assert.equal(m.seen_count, expected.seen_count);
  assert.equal(m.expires_at, expected.expires_at);
  assert.equal(m.read_count, expected.read_count);
  assert.equal(m.opened_count, expected.opened_count);
  assert.equal(m.last_read_at, expected.last_read_at);
  assert.equal(m.last_opened_at, expected.last_opened_at);
  assert.equal(m.created, expected.created);
  assert.equal(m.updated, expected.updated);
  assert.deepEqual(m.tags, expected.tags);
  assert.equal(m.version, expected.version);
  assert.equal(typeof m.preview, 'string');
  assert.ok(m.preview.length > 0 && m.preview.length <= 72);
  assert.ok(expected.value.startsWith(m.preview.replace(/…$/, '')));
}

for (const [name, cluster] of [
  ['clusterDuplicates', clusterDuplicates],
  ['clusterDuplicatesBlocked', clusterDuplicatesBlocked],
]) {
  test(`AC-3: ${name} members carry the lifecycle fields and a preview`, () => {
    const entries = duplicatePair();
    const clusters = cluster(entries, 0.8);
    assert.equal(clusters.length, 1);
    const byKey = new Map(clusters[0].members.map((m) => [m.key, m]));
    for (const e of entries) assertMember(byKey.get(e.key), e);
  });

  test(`AC-3: ${name} keeps the cluster's existing keys`, () => {
    const [cl] = cluster(duplicatePair(), 0.8);
    assert.equal(cl.size, 2);
    assert.equal(typeof cl.minSimilarity, 'number');
    assert.equal(typeof cl.maxSimilarity, 'number');
  });
}

test('AC-3: a raw remote row (no normalization) still yields created/updated', () => {
  // `invariants candidates` clusters raw rows; the member must read both spellings.
  const [cl] = clusterDuplicatesBlocked([remoteRow(), remoteRow({ key: 'other', scope: 'global' })], 0.8);
  const m = cl.members.find((x) => x.key === 'aw-lessons::flaky-cache');
  assert.equal(m.created, '2026-07-01T10:00:00.000Z');
  assert.equal(m.updated, '2026-07-20T10:00:00.000Z');
  assert.equal(m.seen_count, 4);
});

test('AC-4: clusterByKeyPattern members carry the lifecycle fields and a preview', () => {
  const entries = [
    normalizeEntry(remoteRow({ key: 'relevance::pr12-1001::slug-a', value: 'first comment body' })),
    normalizeEntry(remoteRow({ key: 'relevance::pr12-1001::slug-b', value: 'second comment body', seen_count: 9 })),
  ];
  const clusters = clusterByKeyPattern(entries, 'pr(\\d+-\\d+)');
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].keyGroup, '12-1001');
  const byKey = new Map(clusters[0].members.map((m) => [m.key, m]));
  for (const e of entries) assertMember(byKey.get(e.key), e);
});

// ── CLI, offline store ────────────────────────────────────────────────────────

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function lessonFile({ scope, key, value, extra = {} }) {
  const fm = {
    scope,
    key,
    tags: [],
    source_agent: 'aw',
    trigger: 'manual',
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    archived_at: null,
    ...extra,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${value}\n`;
}

function seed() {
  const root = tmp('lk-lifecycle-proj-');
  const home = tmp('lk-lifecycle-home-');
  const store = path.join(root, '.lorekit', 'global');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(
    path.join(store, 'a.md'),
    lessonFile({
      scope: 'global',
      key: 'cache-a',
      value: 'the build cache is flaky on windows ci runners',
      extra: { seen_count: 3, expires_at: '2099-01-01T00:00:00.000Z' },
    }),
  );
  fs.writeFileSync(
    path.join(store, 'b.md'),
    lessonFile({ scope: 'global', key: 'cache-b', value: 'the build cache is flaky on windows ci runners sometimes' }),
  );
  return { root, home };
}

function run(cmd, { root, home }) {
  const env = { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home, LOREKIT_HOME: home, LOREKIT_TELEMETRY: '0' };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  const res = spawnSync(process.execPath, [BIN, cmd, '--json', '--scope', 'global', '--dir', root], { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('AC-5: lorekit dedupe --json prints seen_count and expires_at on the offline member', () => {
  const ctx = seed();
  const out = run('dedupe', ctx);
  assert.equal(out.offline.clusters.length, 1);
  const a = out.offline.clusters[0].members.find((m) => m.key === 'cache-a');
  const b = out.offline.clusters[0].members.find((m) => m.key === 'cache-b');
  assert.equal(a.seen_count, 3);
  assert.equal(a.expires_at, '2099-01-01T00:00:00.000Z');
  assert.strictEqual(a.last_opened_at, null);
  assert.equal(a.updated, '2026-07-20T10:00:00.000Z');
  assert.match(a.preview, /^the build cache is flaky/);
  assert.strictEqual(b.expires_at, null);
});

test('AC-5: lorekit list --json prints seen_count and expires_at on the offline entry', () => {
  const ctx = seed();
  const out = run('list', ctx);
  const entries = out.offline.groups.flatMap((g) => g.entries);
  const a = entries.find((e) => e.key === 'cache-a');
  assert.ok(a, 'cache-a listed');
  assert.equal(a.seen_count, 3);
  assert.equal(a.expires_at, '2099-01-01T00:00:00.000Z');
  for (const k of ['read_count', 'opened_count', 'last_read_at', 'last_opened_at']) {
    assert.strictEqual(a[k], null, `${k} should be null`);
  }
});
