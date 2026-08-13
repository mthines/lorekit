import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacets, FACET_NAMES } from './facets.mjs';

const NOW = '2026-06-15T00:00:00.000Z';

function row(overrides = {}) {
  return {
    scope: 'project::facet-a', key: 'k', value: 'v', tags: [],
    source_agent: null, trigger: null, kind: null, host: null,
    origin_repo: null, origin_branch: null, origin_pr: null,
    archived_at: null, expires_at: null,
    ...overrides,
  };
}

function countOf(facets, facet, value) {
  const hit = facets.find((f) => f.facet === facet && f.value === value);
  return hit ? hit.count : 0;
}

// ── §69 global-catalog cases ────────────────────────────────────────────────

test('AC-1: global counts — source_agent aw counts every matching live row', () => {
  const rows = [
    row({ key: 'a1', source_agent: 'aw', trigger: 'stuck-loop', origin_branch: 'main', origin_pr: 311 }),
    row({ key: 'a2', source_agent: 'aw', trigger: 'stuck-loop', origin_branch: 'feat/x', origin_pr: 311 }),
  ];
  const facets = computeFacets(rows, {}, NOW);
  assert.equal(countOf(facets, 'source_agent', 'aw'), 2);
});

test('AC-1b/1c: origin_branch and origin_pr (as text) are counted correctly', () => {
  const rows = [
    row({ key: 'a1', origin_branch: 'main', origin_pr: 311 }),
    row({ key: 'a2', origin_branch: 'feat/x', origin_pr: 311 }),
  ];
  const facets = computeFacets(rows, {}, NOW);
  assert.equal(countOf(facets, 'origin_branch', 'main'), 1);
  assert.equal(countOf(facets, 'origin_pr', '311'), 2);
});

test('AC-2: a null or blank column value yields no facet row', () => {
  const rows = [row({ key: 'blank', source_agent: '   ', trigger: null, origin_branch: null, origin_pr: null })];
  const facets = computeFacets(rows, {}, NOW);
  assert.equal(facets.length, 0, `expected no facet rows for an all-blank/null row, got ${JSON.stringify(facets)}`);
});

test('AC-3: an archived row must not contribute to the active catalog, but does to the archived one', () => {
  const rows = [row({ key: 'retired', source_agent: 'retired-agent', archived_at: '2026-01-01T00:00:00.000Z' })];
  assert.equal(countOf(computeFacets(rows, {}, NOW), 'source_agent', 'retired-agent'), 0);
  assert.equal(countOf(computeFacets(rows, { archived: 'true' }, NOW), 'source_agent', 'retired-agent'), 1);
});

test('AC-6: results are ordered facet asc, count desc, value asc', () => {
  const rows = [
    row({ key: 'a', source_agent: 'zzz' }),
    row({ key: 'b', source_agent: 'aaa' }),
    row({ key: 'c', source_agent: 'aaa' }),
    row({ key: 'd', trigger: 'only-one' }),
  ];
  const facets = computeFacets(rows, {}, NOW);
  const sorted = [...facets].sort((x, y) => {
    if (x.facet !== y.facet) return x.facet < y.facet ? -1 : 1;
    if (x.count !== y.count) return y.count - x.count;
    return x.value < y.value ? -1 : x.value > y.value ? 1 : 0;
  });
  assert.deepEqual(facets, sorted);
});

test('?facets= narrows to named dimensions; an unknown name narrows to nothing', () => {
  const rows = [row({ key: 'a', source_agent: 'aw', trigger: 't1' })];
  const only = computeFacets(rows, { facets: 'source_agent' }, NOW);
  assert.ok(only.every((f) => f.facet === 'source_agent'));
  assert.ok(only.length > 0);
  const unknown = computeFacets(rows, { facets: 'nope' }, NOW);
  assert.equal(unknown.length, 0);
});

test('every declared facet name is a real dimension', () => {
  assert.deepEqual(FACET_NAMES, ['tag', 'source_agent', 'trigger', 'kind', 'host', 'origin_repo', 'origin_branch', 'origin_pr']);
});

// ── §69b drill-down + self-exclusion cases ──────────────────────────────────

function ddRows() {
  return [
    row({ key: 'dd-1', source_agent: 'aw', kind: 'lesson', host: 'reviewer', tags: ['dd-alpha', 'dd-shared'], origin_pr: 7 }),
    row({ key: 'dd-2', source_agent: 'aw', kind: 'lesson', host: 'aw', tags: ['dd-shared'], origin_pr: 7 }),
    row({ key: 'dd-3', source_agent: 'bee', kind: 'signal', host: 'reviewer', tags: ['dd-beta', 'dd-shared'], origin_pr: 42 }),
  ];
}

test('drill-down AC-1: kind and host appear as their own dimensions with global counts', () => {
  const facets = computeFacets(ddRows(), {}, NOW);
  assert.equal(countOf(facets, 'kind', 'lesson'), 2);
  assert.equal(countOf(facets, 'host', 'reviewer'), 2);
});

test('drill-down AC-2: filtering kind=lesson narrows host reviewer from 2 to 1', () => {
  const facets = computeFacets(ddRows(), { kind: 'lesson', kind_mode: 'in' }, NOW);
  assert.equal(countOf(facets, 'host', 'reviewer'), 1);
});

test('drill-down AC-3: self-exclusion — the same kind filter does not collapse the kind dimension', () => {
  const facets = computeFacets(ddRows(), { kind: 'lesson', kind_mode: 'in' }, NOW);
  assert.equal(countOf(facets, 'kind', 'signal'), 1, 'signal must stay visible so the user can switch to it');
});

test('drill-down AC-4: the tag dimension drills down like the scalar ones', () => {
  const facets = computeFacets(ddRows(), { kind: 'lesson', kind_mode: 'in' }, NOW);
  assert.equal(countOf(facets, 'tag', 'dd-shared'), 2);
  assert.equal(countOf(facets, 'tag', 'dd-beta'), 0, 'dd-beta lives only on the signal row and must not survive kind=lesson');
});

test('drill-down AC-4c: the tag dimension self-excludes too', () => {
  const facets = computeFacets(ddRows(), { tags: 'dd-alpha', tags_mode: 'any' }, NOW);
  assert.equal(countOf(facets, 'tag', 'dd-beta'), 1, 'filtering on dd-alpha must not collapse the tag dimension to just that value');
});

test('drill-down AC-5: nin is its own case and self-excludes too', () => {
  const nin = computeFacets(ddRows(), { kind: 'lesson', kind_mode: 'nin' }, NOW);
  assert.equal(countOf(nin, 'host', 'reviewer'), 1, 'under kind NOT IN (lesson) only the signal row (dd-3) remains for host');
  assert.equal(countOf(nin, 'kind', 'lesson'), 2, 'self-exclusion must keep the excluded value visible');
});

test('drill-down AC-6: origin_pr is compared numerically — zero-padded "007" matches PR 7', () => {
  const facets = computeFacets(ddRows(), { origin_pr: '007', origin_pr_mode: 'in' }, NOW);
  assert.equal(countOf(facets, 'kind', 'lesson'), 2);
});

test('drill-down AC-6b: an all-non-numeric origin_pr list filters nothing', () => {
  const facets = computeFacets(ddRows(), { origin_pr: 'not-a-number', origin_pr_mode: 'in' }, NOW);
  assert.equal(countOf(facets, 'kind', 'lesson'), 2);
});

test('no filters supplied returns the unfiltered global catalog', () => {
  const noFilter = computeFacets(ddRows(), {}, NOW);
  const explicitNull = computeFacets(ddRows(), { kind: undefined }, NOW);
  assert.deepEqual(noFilter, explicitNull);
});
