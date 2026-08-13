import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, parseList, expiringWindow } from './rowFilter.mjs';

const NOW = '2026-06-15T00:00:00.000Z';

function row(overrides = {}) {
  return {
    scope: 'global', key: 'my-key', value: 'the body', tags: [],
    source_agent: null, trigger: null, kind: null, host: null,
    origin_repo: null, origin_branch: null, origin_pr: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
    expires_at: null, archived_at: null,
    ...overrides,
  };
}

test('parseList splits, trims, and drops empties', () => {
  assert.deepEqual(parseList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList(',,'), []);
});

test('default (no filters) returns only live rows, newest-first is the caller\'s job', () => {
  const rows = [row({ key: 'a' }), row({ key: 'b', archived_at: '2026-01-05T00:00:00.000Z' })];
  const out = applyFilters(rows, {}, NOW);
  assert.deepEqual(out.map((r) => r.key), ['a']);
});

test('archived=true returns only archived rows', () => {
  const rows = [row({ key: 'a' }), row({ key: 'b', archived_at: '2026-01-05T00:00:00.000Z' })];
  const out = applyFilters(rows, { archived: 'true' }, NOW);
  assert.deepEqual(out.map((r) => r.key), ['b']);
});

test('an expired (but not archived) row is excluded from the default partition', () => {
  const rows = [
    row({ key: 'live' }),
    row({ key: 'expired', expires_at: '2026-01-01T00:00:00.000Z' }),
    row({ key: 'future-expiry', expires_at: '2027-01-01T00:00:00.000Z' }),
  ];
  const out = applyFilters(rows, {}, NOW);
  assert.deepEqual(out.map((r) => r.key).sort(), ['future-expiry', 'live']);
});

test('scope and exact key filters', () => {
  const rows = [row({ scope: 'a', key: 'x' }), row({ scope: 'b', key: 'x' }), row({ scope: 'a', key: 'y' })];
  assert.deepEqual(applyFilters(rows, { scope: 'a' }, NOW).map((r) => r.key), ['x', 'y']);
  assert.deepEqual(applyFilters(rows, { key: 'x' }, NOW).map((r) => r.scope), ['a', 'b']);
});

test('key_prefix is a case-insensitive prefix match, distinct from exact key', () => {
  const rows = [row({ key: 'Prefer-Guards' }), row({ key: 'other' })];
  assert.deepEqual(applyFilters(rows, { key_prefix: 'prefer' }, NOW).map((r) => r.key), ['Prefer-Guards']);
});

test('q matches a case-insensitive substring of key OR value', () => {
  const rows = [row({ key: 'alpha', value: 'nothing' }), row({ key: 'other', value: 'has ALPHA in it' }), row({ key: 'none', value: 'nope' })];
  assert.deepEqual(applyFilters(rows, { q: 'alpha' }, NOW).map((r) => r.key).sort(), ['alpha', 'other']);
});

test('tags_mode=any (default) is disjunction', () => {
  const rows = [row({ key: 'a', tags: ['x'] }), row({ key: 'b', tags: ['y'] }), row({ key: 'c', tags: [] })];
  assert.deepEqual(applyFilters(rows, { tags: 'x,y' }, NOW).map((r) => r.key).sort(), ['a', 'b']);
});

test('tags_mode=all is containment', () => {
  const rows = [row({ key: 'both', tags: ['x', 'y'] }), row({ key: 'one', tags: ['x'] })];
  assert.deepEqual(applyFilters(rows, { tags: 'x,y', tags_mode: 'all' }, NOW).map((r) => r.key), ['both']);
});

test('tags_mode=none is the negation of any', () => {
  const rows = [row({ key: 'has', tags: ['x'] }), row({ key: 'clean', tags: ['z'] })];
  assert.deepEqual(applyFilters(rows, { tags: 'x', tags_mode: 'none' }, NOW).map((r) => r.key), ['clean']);
});

test('scalar filter (source_agent) in/nin, and nin never matches a null column', () => {
  const rows = [row({ key: 'claude', source_agent: 'claude' }), row({ key: 'aw', source_agent: 'aw' }), row({ key: 'none', source_agent: null })];
  assert.deepEqual(applyFilters(rows, { source_agent: 'claude' }, NOW).map((r) => r.key), ['claude']);
  assert.deepEqual(
    applyFilters(rows, { source_agent: 'claude', source_agent_mode: 'nin' }, NOW).map((r) => r.key),
    ['aw'],
    'nin must exclude a row with no value at all, mirroring SQL NULL comparison semantics',
  );
});

test('scalar filters cover trigger, kind, host, origin_repo, origin_branch identically', () => {
  const rows = [
    row({ key: 'a', trigger: 't1', kind: 'lesson', host: 'aw', origin_repo: 'acme/x', origin_branch: 'main' }),
    row({ key: 'b', trigger: 't2', kind: 'signal', host: 'ci', origin_repo: 'acme/y', origin_branch: 'feat' }),
  ];
  assert.deepEqual(applyFilters(rows, { trigger: 't1' }, NOW).map((r) => r.key), ['a']);
  assert.deepEqual(applyFilters(rows, { kind: 'signal' }, NOW).map((r) => r.key), ['b']);
  assert.deepEqual(applyFilters(rows, { host: 'aw' }, NOW).map((r) => r.key), ['a']);
  assert.deepEqual(applyFilters(rows, { origin_repo: 'acme/y' }, NOW).map((r) => r.key), ['b']);
  assert.deepEqual(applyFilters(rows, { origin_branch: 'main' }, NOW).map((r) => r.key), ['a']);
});

test('origin_pr compares numerically — zero-padded "007" matches PR 7', () => {
  const rows = [row({ key: 'seven', origin_pr: 7 }), row({ key: 'eight', origin_pr: 8 })];
  assert.deepEqual(applyFilters(rows, { origin_pr: '007' }, NOW).map((r) => r.key), ['seven']);
});

test('a non-numeric origin_pr list applies no filter at all', () => {
  const rows = [row({ key: 'a', origin_pr: 7 }), row({ key: 'b', origin_pr: null })];
  assert.deepEqual(applyFilters(rows, { origin_pr: 'not-a-number' }, NOW).map((r) => r.key).sort(), ['a', 'b']);
});

test('created_since/created_until is a half-open [since, until) window', () => {
  const rows = [
    row({ key: 'jan', created_at: '2026-01-01T00:00:00.000Z' }),
    row({ key: 'feb', created_at: '2026-02-01T00:00:00.000Z' }),
    row({ key: 'mar', created_at: '2026-03-01T00:00:00.000Z' }),
  ];
  const out = applyFilters(rows, { created_since: '2026-02-01T00:00:00.000Z', created_until: '2026-03-01T00:00:00.000Z' }, NOW);
  assert.deepEqual(out.map((r) => r.key), ['feb']);
});

test('expiring_within_days keeps only rows whose TTL runs out in (now, now+N days]', () => {
  const rows = [
    row({ key: 'no-ttl', expires_at: null }),
    row({ key: 'in-3-days', expires_at: new Date(Date.parse(NOW) + 3 * 86_400_000).toISOString() }),
    row({ key: 'in-30-days', expires_at: new Date(Date.parse(NOW) + 30 * 86_400_000).toISOString() }),
    row({ key: 'already-expired', expires_at: new Date(Date.parse(NOW) - 86_400_000).toISOString(), archived_at: null }),
  ];
  const out = applyFilters(rows, { expiring_within_days: 7 }, NOW);
  assert.deepEqual(out.map((r) => r.key), ['in-3-days']);
});

test('expiringWindow exact boundary is exclusive-lower, inclusive-upper', () => {
  const w = expiringWindow(7, NOW);
  assert.equal(w.after, NOW);
  assert.equal(w.onOrBefore, new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString());
});

test('expiring_within_days composes with archived=true rather than rejecting the combination', () => {
  const rows = [
    row({
      key: 'archived-expiring',
      archived_at: '2026-06-01T00:00:00.000Z',
      expires_at: new Date(Date.parse(NOW) + 3 * 86_400_000).toISOString(),
    }),
    row({ key: 'archived-not-expiring', archived_at: '2026-06-01T00:00:00.000Z', expires_at: null }),
  ];
  const out = applyFilters(rows, { archived: 'true', expiring_within_days: 7 }, NOW);
  assert.deepEqual(out.map((r) => r.key), ['archived-expiring']);
});

test('every dimension ANDs together — narrowing by two filters intersects', () => {
  const rows = [
    row({ key: 'match', tags: ['perf'], source_agent: 'claude' }),
    row({ key: 'tag-only', tags: ['perf'], source_agent: 'aw' }),
    row({ key: 'agent-only', tags: ['ci'], source_agent: 'claude' }),
  ];
  const out = applyFilters(rows, { tags: 'perf', source_agent: 'claude' }, NOW);
  assert.deepEqual(out.map((r) => r.key), ['match']);
});
