/**
 * Contract tests for the Explorer filter bar's pure model.
 *
 * These pin the four things the UI is not allowed to get wrong: the
 * normalisation of a hand-editable `?filters=` param, the one-pill-per-
 * dimension invariant, the operator vocabulary (which is derived from
 * cardinality and must never flip polarity), and the translation to query
 * params — the single seam between the UI vocabulary and the wire.
 */

import { describe, it, expect } from 'vitest';
import {
  ListFacetsQuerySchema,
  ListMemoriesQuerySchema,
  MemoryFacetSchema,
} from '@lorekit/schemas/memory';
import {
  FILTER_FIELDS,
  facetOptions,
  fieldDescriptor,
  filterCount,
  filterPhrase,
  filtersFromLegacyTags,
  filtersPhrase,
  filtersToFacetParams,
  filtersToQueryParams,
  findFilter,
  isValueSelected,
  normalizeFilters,
  operatorLabel,
  filtersParamValue,
  removeFilter,
  resolveFilters,
  ROOT_VALUE_LIMIT,
  rootSuggestions,
  searchOptions,
  selectedValues,
  setFilterOperator,
  toggleFilterValue,
  valueSummary,
  type FacetValue,
  type Filter,
} from './filters';

const FACETS: FacetValue[] = [
  { facet: 'tag', value: 'perf', count: 12 },
  { facet: 'tag', value: 'ci/flaky', count: 4 },
  { facet: 'source_agent', value: 'claude', count: 30 },
  { facet: 'source_agent', value: 'aw', count: 9 },
  { facet: 'trigger', value: 'tool-failure', count: 6 },
  { facet: 'origin_repo', value: 'mthines/lorekit', count: 20 },
  { facet: 'origin_branch', value: 'main', count: 14 },
  { facet: 'origin_branch', value: 'feat/maintenance', count: 2 },
  { facet: 'origin_pr', value: '482', count: 3 },
];

describe('normalizeFilters', () => {
  it('degrades anything unusable to an empty bar rather than throwing', () => {
    expect(normalizeFilters(undefined)).toEqual([]);
    expect(normalizeFilters('nonsense')).toEqual([]);
    expect(normalizeFilters([null, 7, 'x', {}])).toEqual([]);
  });

  it('drops a filter naming a field that does not exist', () => {
    expect(normalizeFilters([{ field: 'assignee', operator: 'in', values: ['x'] }])).toEqual([]);
  });

  it('drops a filter with no usable values — an empty pill cannot be cleared', () => {
    expect(normalizeFilters([{ field: 'label', operator: 'in', values: [] }])).toEqual([]);
    expect(normalizeFilters([{ field: 'label', operator: 'in', values: ['  ', 3] }])).toEqual([]);
  });

  it('trims, de-duplicates, and preserves first-seen value order', () => {
    expect(
      normalizeFilters([{ field: 'label', operator: 'in', values: [' perf ', 'ci', 'perf'] }]),
    ).toEqual([{ field: 'label', operator: 'in', values: ['perf', 'ci'] }]);
  });

  it('falls back to the field default for an operator the field does not offer', () => {
    // `all` is legal only for `label` — a scalar dimension holds one value per row.
    expect(normalizeFilters([{ field: 'agent', operator: 'all', values: ['aw'] }])).toEqual([
      { field: 'agent', operator: 'in', values: ['aw'] },
    ]);
  });

  it('merges a duplicated field into one filter rather than dropping half of it', () => {
    expect(
      normalizeFilters([
        { field: 'label', operator: 'in', values: ['perf'] },
        { field: 'label', operator: 'nin', values: ['ci'] },
      ]),
    ).toEqual([{ field: 'label', operator: 'in', values: ['perf', 'ci'] }]);
  });

  it('emits in FILTER_FIELDS order so a shared link renders identically', () => {
    const out = normalizeFilters([
      { field: 'pr', operator: 'in', values: ['482'] },
      { field: 'label', operator: 'all', values: ['perf'] },
      { field: 'agent', operator: 'in', values: ['aw'] },
    ]);
    expect(out.map((f) => f.field)).toEqual(['label', 'agent', 'pr']);
  });
});

describe('filtersFromLegacyTags', () => {
  it('preserves the AND semantics the ?tags= param has always had', () => {
    expect(filtersFromLegacyTags(['perf', 'ci'])).toEqual([
      { field: 'label', operator: 'all', values: ['perf', 'ci'] },
    ]);
  });

  it('is empty for anything that is not a usable label list', () => {
    expect(filtersFromLegacyTags(undefined)).toEqual([]);
    expect(filtersFromLegacyTags([])).toEqual([]);
    expect(filtersFromLegacyTags('perf')).toEqual([]);
  });
});

// The pair below is what makes a legacy `?tags=` link's pill REMOVABLE. The
// bar's first shape read an empty `?filters=` as "untouched" and fell back to
// the legacy shorthand, so clicking the last pill's × re-derived the filter it
// had just removed and nothing in the UI could clear it.
describe('resolveFilters', () => {
  it('honours the legacy ?tags= shorthand while ?filters= is absent', () => {
    expect(resolveFilters(null, ['perf'])).toEqual([
      { field: 'label', operator: 'all', values: ['perf'] },
    ]);
  });

  it('lets an EXPLICITLY EMPTY ?filters= beat the legacy shorthand', () => {
    expect(resolveFilters([], ['perf'])).toEqual([]);
  });

  it('lets an explicit ?filters= beat the legacy shorthand', () => {
    expect(resolveFilters([{ field: 'agent', operator: 'in', values: ['aw'] }], ['perf'])).toEqual([
      { field: 'agent', operator: 'in', values: ['aw'] },
    ]);
  });

  it('normalises the explicit param rather than trusting it', () => {
    expect(resolveFilters([{ field: 'nope', operator: 'in', values: ['x'] }], ['perf'])).toEqual([]);
  });
});

describe('filtersParamValue', () => {
  it('keeps an explicit empty marker when a legacy ?tags= link is in play', () => {
    expect(filtersParamValue([], ['perf'])).toEqual([]);
  });

  it('drops the param entirely when there is no legacy link to override', () => {
    expect(filtersParamValue([], [])).toBeNull();
  });

  it('persists a non-empty bar as itself', () => {
    const filters: Filter[] = [{ field: 'label', operator: 'all', values: ['perf'] }];
    expect(filtersParamValue(filters, ['perf'])).toEqual(filters);
  });
});

describe('toggleFilterValue', () => {
  it('creates the filter with the field default on the first toggle', () => {
    expect(toggleFilterValue([], 'label', 'perf')).toEqual([
      { field: 'label', operator: 'all', values: ['perf'] },
    ]);
    expect(toggleFilterValue([], 'branch', 'main')).toEqual([
      { field: 'branch', operator: 'in', values: ['main'] },
    ]);
  });

  it('adds a second value to the existing filter, keeping the operator', () => {
    const one = toggleFilterValue([], 'agent', 'aw');
    const negated = setFilterOperator(one, 'agent', 'nin');
    const two = toggleFilterValue(negated, 'agent', 'claude');
    // Polarity survives: adding a value must not silently flip `is not`.
    expect(two).toEqual([{ field: 'agent', operator: 'nin', values: ['aw', 'claude'] }]);
  });

  it('removes the filter entirely when its last value is toggled off', () => {
    const one = toggleFilterValue([], 'agent', 'aw');
    expect(toggleFilterValue(one, 'agent', 'aw')).toEqual([]);
  });

  it('ignores a blank value', () => {
    expect(toggleFilterValue([], 'agent', '   ')).toEqual([]);
  });
});

describe('setFilterOperator / removeFilter', () => {
  const bar: Filter[] = [
    { field: 'label', operator: 'all', values: ['perf'] },
    { field: 'agent', operator: 'in', values: ['aw'] },
  ];

  it('changes only the named field', () => {
    expect(setFilterOperator(bar, 'label', 'nin')).toEqual([
      { field: 'label', operator: 'nin', values: ['perf'] },
      { field: 'agent', operator: 'in', values: ['aw'] },
    ]);
  });

  it('is a no-op for an operator the field does not offer', () => {
    expect(setFilterOperator(bar, 'agent', 'all')).toEqual(bar);
  });

  it('removes one pill and leaves the rest', () => {
    expect(removeFilter(bar, 'label').map((f) => f.field)).toEqual(['agent']);
  });
});

describe('reading helpers', () => {
  const bar: Filter[] = [{ field: 'label', operator: 'all', values: ['perf', 'ci'] }];

  it('finds a filter by field', () => {
    expect(findFilter(bar, 'label')?.values).toEqual(['perf', 'ci']);
    expect(findFilter(bar, 'agent')).toBeUndefined();
  });

  it('reports selected values, and none for a field with no filter', () => {
    expect(selectedValues(bar, 'label')).toEqual(['perf', 'ci']);
    expect(selectedValues(bar, 'branch')).toEqual([]);
  });

  it('matches a selected value after trimming', () => {
    expect(isValueSelected(bar, 'label', ' perf ')).toBe(true);
    expect(isValueSelected(bar, 'label', 'other')).toBe(false);
  });

  it('counts committed conditions, not array entries', () => {
    expect(filterCount([])).toBe(0);
    expect(filterCount(bar)).toBe(1);
    expect(
      filterCount([
        { field: 'label', operator: 'all', values: ['perf'] },
        { field: 'agent', operator: 'in', values: ['claude'] },
      ]),
    ).toBe(2);
  });

  it('normalises before counting, so the badge cannot over-report', () => {
    // Two pills of one dimension merge into one condition, and a valueless
    // pill is not a condition at all — both are `normalizeFilters` invariants
    // the trigger badge must inherit rather than restate.
    expect(
      filterCount([
        { field: 'label', operator: 'all', values: ['perf'] },
        { field: 'label', operator: 'all', values: ['ci'] },
        { field: 'agent', operator: 'in', values: [] },
      ]),
    ).toBe(1);
  });
});

describe('operatorLabel', () => {
  it('gives labels their own set-valued vocabulary', () => {
    expect(operatorLabel('label', 'all', 2)).toBe('includes all');
    expect(operatorLabel('label', 'in', 2)).toBe('includes any');
    expect(operatorLabel('label', 'nin', 1)).toBe('includes none');
  });

  it('derives the scalar positive form from cardinality', () => {
    expect(operatorLabel('agent', 'in', 1)).toBe('is');
    expect(operatorLabel('agent', 'in', 2)).toBe('is either of');
  });

  it('keeps one negated form regardless of cardinality', () => {
    expect(operatorLabel('agent', 'nin', 1)).toBe('is not');
    expect(operatorLabel('agent', 'nin', 3)).toBe('is not');
  });
});

describe('valueSummary / filterPhrase', () => {
  it('names the first values and counts the rest', () => {
    expect(valueSummary('label', ['a', 'b', 'c', 'd'])).toBe('a, b +2');
    expect(valueSummary('label', ['a'])).toBe('a');
  });

  it('formats a pull request as #N', () => {
    expect(valueSummary('pr', ['482'])).toBe('#482');
  });

  it('never truncates the phrase — an AT user has no +2 to hover', () => {
    expect(
      filterPhrase({ field: 'label', operator: 'all', values: ['a', 'b', 'c', 'd'] }),
    ).toBe('Label includes all a, b, c, d');
  });

  it('joins the whole bar for the trigger name', () => {
    expect(
      filtersPhrase([
        { field: 'label', operator: 'all', values: ['perf'] },
        { field: 'branch', operator: 'nin', values: ['main'] },
      ]),
    ).toBe('Label includes all perf; Branch is not main');
    expect(filtersPhrase([])).toBe('Add filter');
  });
});

describe('facetOptions', () => {
  it('returns only the dimension asked for, in catalog order', () => {
    expect(facetOptions(FACETS, 'agent', []).map((o) => o.value)).toEqual(['claude', 'aw']);
  });

  it('appends a selected value the catalog does not cover with an unknown count', () => {
    expect(facetOptions(FACETS, 'branch', ['gone'])).toEqual([
      { value: 'main', count: 14 },
      { value: 'feat/maintenance', count: 2 },
      { value: 'gone', count: null },
    ]);
  });

  it('never strands a selection when the catalog is empty', () => {
    expect(facetOptions([], 'label', ['perf'])).toEqual([{ value: 'perf', count: null }]);
  });

  it('does not hoist selected options — a list that reorders on toggle mis-clicks', () => {
    expect(facetOptions(FACETS, 'agent', ['aw']).map((o) => o.value)).toEqual(['claude', 'aw']);
  });
});

describe('searchOptions', () => {
  const options = facetOptions(FACETS, 'branch', []);

  it('matches everything for a blank query', () => {
    expect(searchOptions(options, '')).toHaveLength(2);
    expect(searchOptions(options, '   ')).toHaveLength(2);
  });

  it('matches a substring anywhere, case-insensitively', () => {
    expect(searchOptions(options, 'MAIN').map((o) => o.value)).toEqual(['main', 'feat/maintenance']);
    expect(searchOptions(options, 'feat/').map((o) => o.value)).toEqual(['feat/maintenance']);
  });

  it('treats regex metacharacters literally', () => {
    expect(searchOptions(options, '.*')).toEqual([]);
  });
});

describe('rootSuggestions', () => {
  it('lists every dimension when there is no query', () => {
    expect(rootSuggestions(FACETS, '')).toEqual(
      FILTER_FIELDS.map((d) => ({ kind: 'field', field: d.field })),
    );
  });

  it('surfaces a value from any dimension without choosing the dimension first', () => {
    const hits = rootSuggestions(FACETS, 'main');
    expect(hits).toContainEqual({ kind: 'value', field: 'branch', value: 'main', count: 14 });
  });

  it('ranks a matching dimension name above any value', () => {
    const hits = rootSuggestions(FACETS, 'branch');
    expect(hits[0]).toEqual({ kind: 'field', field: 'branch' });
  });

  it('caps the value hits so an unbounded catalog cannot flood the menu', () => {
    const many: FacetValue[] = Array.from({ length: 30 }, (_, i) => ({
      facet: 'origin_branch' as const,
      value: `feat/x-${i}`,
      count: 1,
    }));
    const hits = rootSuggestions(many, 'feat', 5);
    expect(hits.filter((h) => h.kind === 'value')).toHaveLength(5);
  });

  // `GET /memories/facets` returns rows `facet asc, count desc, value asc`
  // (migration 00052), so `origin_branch` — alphabetically first — arrives
  // before `tag`. Draining the catalog in arrival order spent the whole cap on
  // branches and starved every other dimension, which is the opposite of what
  // a CROSS-dimension type-ahead is for.
  const STARVING_CATALOG: FacetValue[] = [
    ...Array.from({ length: 8 }, (_, i) => ({
      facet: 'origin_branch' as const,
      value: `feat/main-${i}`,
      count: 50 - i,
    })),
    { facet: 'tag', value: 'main', count: 3 },
    { facet: 'trigger', value: 'main-push', count: 2 },
  ];

  it('surfaces a low-count label even when eight branches match the same query', () => {
    expect(rootSuggestions(STARVING_CATALOG, 'main')).toContainEqual({
      kind: 'value',
      field: 'label',
      value: 'main',
      count: 3,
    });
  });

  it('gives every matching dimension a slot before any takes a second one', () => {
    const values = rootSuggestions(STARVING_CATALOG, 'main').filter((h) => h.kind === 'value');
    // Menu order (FILTER_FIELDS), one per dimension per pass, then the rest.
    expect(values.slice(0, 3).map((h) => h.field)).toEqual(['label', 'trigger', 'branch']);
    expect(values).toHaveLength(ROOT_VALUE_LIMIT);
  });

  it('returns nothing at all when neither a dimension nor a value matches', () => {
    expect(rootSuggestions(FACETS, 'zzz')).toEqual([]);
  });
});

describe('filtersToQueryParams', () => {
  it('sends nothing for an empty bar', () => {
    expect(filtersToQueryParams([])).toEqual({});
  });

  it('maps every label operator onto its tags_mode', () => {
    expect(filtersToQueryParams([{ field: 'label', operator: 'all', values: ['a', 'b'] }]))
      .toEqual({ tags: 'a,b', tags_mode: 'all' });
    expect(filtersToQueryParams([{ field: 'label', operator: 'in', values: ['a'] }]))
      .toEqual({ tags: 'a', tags_mode: 'any' });
    expect(filtersToQueryParams([{ field: 'label', operator: 'nin', values: ['a'] }]))
      .toEqual({ tags: 'a', tags_mode: 'none' });
  });

  it('maps each scalar dimension onto its column and mode', () => {
    expect(
      filtersToQueryParams([
        { field: 'agent', operator: 'in', values: ['aw', 'claude'] },
        { field: 'trigger', operator: 'nin', values: ['tool-failure'] },
        { field: 'repo', operator: 'in', values: ['mthines/lorekit'] },
        { field: 'branch', operator: 'in', values: ['main'] },
      ]),
    ).toEqual({
      source_agent: 'aw,claude',
      source_agent_mode: 'in',
      trigger: 'tool-failure',
      trigger_mode: 'nin',
      origin_repo: 'mthines/lorekit',
      origin_repo_mode: 'in',
      origin_branch: 'main',
      origin_branch_mode: 'in',
    });
  });

  it('sends only digits for a pull request, and omits the param when none remain', () => {
    expect(filtersToQueryParams([{ field: 'pr', operator: 'in', values: ['482', 'oops'] }]))
      .toEqual({ origin_pr: '482', origin_pr_mode: 'in' });
    expect(filtersToQueryParams([{ field: 'pr', operator: 'in', values: ['oops'] }])).toEqual({});
  });

  it('normalises before translating, so a malformed bar cannot reach the wire', () => {
    expect(
      filtersToQueryParams([
        { field: 'agent', operator: 'all', values: [' aw ', 'aw'] } as unknown as Filter,
      ]),
    ).toEqual({ source_agent: 'aw', source_agent_mode: 'in' });
  });
});

describe('filtersToFacetParams', () => {
  it('sends nothing for an empty bar — the endpoint returns the global catalog', () => {
    expect(filtersToFacetParams([])).toEqual({});
  });

  it('carries the same dimension params as the list route, so a menu passes its state verbatim', () => {
    const bar: Filter[] = [
      { field: 'label', operator: 'all', values: ['auth', 'perf'] },
      { field: 'agent', operator: 'in', values: ['claude'] },
      { field: 'pr', operator: 'nin', values: ['311'] },
    ];
    // The facets route mirrors the list route's dimension params by name, so the
    // two translations are byte-for-byte identical — the drill-down is entirely
    // the endpoint's job (self-exclusion), not the client's.
    expect(filtersToFacetParams(bar)).toEqual(filtersToQueryParams(bar));
    expect(filtersToFacetParams(bar)).toEqual({
      tags: 'auth,perf',
      tags_mode: 'all',
      source_agent: 'claude',
      source_agent_mode: 'in',
      origin_pr: '311',
      origin_pr_mode: 'nin',
    });
  });

  it('emits only keys the facets route accepts, so the cast cannot silently drift', () => {
    // The `Partial<ListFacetsQuery>` cast in `filtersToFacetParams` is only sound
    // while every key it can emit is a real facets param. Exercise the whole
    // union — one filter per dimension — and assert each key is in the schema, so
    // a future field mapped to a param the route does not accept fails here
    // instead of being silently dropped on the wire.
    const oneEach: Filter[] = FILTER_FIELDS.map((d) => ({
      field: d.field,
      operator: d.operators[0],
      values: d.field === 'pr' ? ['1'] : ['x'],
    }));
    const params = filtersToFacetParams(oneEach);
    const allowed = new Set(Object.keys(ListFacetsQuerySchema.shape));

    // Anti-vacuity: it actually produced params for every dimension.
    expect(Object.keys(params).length).toBeGreaterThanOrEqual(FILTER_FIELDS.length);
    for (const key of Object.keys(params)) {
      expect(allowed, `"${key}" is not a ListFacetsQuery param`).toContain(key);
    }
  });
});

/**
 * The taxonomy pair (`kind` / `host`, migrations 00056 + 00057).
 *
 * `GET /memories` has accepted both params since 00056 and the handler has
 * always filtered on them; `GET /memories/facets` has catalogued their values
 * since 00057. The only missing piece was a `FILTER_FIELDS` row, so the facet
 * rows arrived and were silently dropped. These assert the wiring the pills
 * now depend on — the shared guards above (facet uniqueness, the facets-param
 * cast, menu ordering) cover the two new rows automatically because they
 * iterate `FILTER_FIELDS`.
 */
describe('kind & host dimensions', () => {
  it('are offered as dimensions with their own facet catalogs', () => {
    const kind = fieldDescriptor('kind');
    const host = fieldDescriptor('host');
    expect(kind?.facet).toBe('kind');
    expect(host?.facet).toBe('host');
    // Scalar columns: one value per row, so containment ("includes all") is not
    // a question that can be asked of them — that is `label`'s alone.
    expect(kind?.operators).toEqual(['in', 'nin']);
    expect(host?.operators).toEqual(['in', 'nin']);
  });

  it('emit the GET /memories params the handler already understands', () => {
    expect(
      filtersToQueryParams([
        { field: 'kind', operator: 'in', values: ['lesson', 'signal'] },
        { field: 'host', operator: 'in', values: ['reviewer'] },
      ]),
    ).toEqual({
      kind: 'lesson,signal',
      kind_mode: 'in',
      host: 'reviewer',
      host_mode: 'in',
    });
  });

  it('negate through *_mode=nin rather than a second param', () => {
    expect(filtersToQueryParams([{ field: 'kind', operator: 'nin', values: ['bus'] }])).toEqual({
      kind: 'bus',
      kind_mode: 'nin',
    });
  });

  it('read as the phrase the taxonomy exists for', () => {
    // `?kind=lesson&host=reviewer` is "reviewer's lessons" — the example the
    // schema docblock and the contributor docs both use.
    expect(filterPhrase({ field: 'kind', operator: 'in', values: ['lesson'] })).toBe('Kind is lesson');
    expect(filterPhrase({ field: 'host', operator: 'in', values: ['reviewer'] })).toBe(
      'Host is reviewer',
    );
    expect(filterPhrase({ field: 'kind', operator: 'in', values: ['lesson', 'bus'] })).toBe(
      'Kind is either of lesson, bus',
    );
  });

  it('normalise like every other scalar dimension', () => {
    // One pill per dimension: a duplicated field MERGES rather than half-dropping.
    expect(
      normalizeFilters([
        { field: 'kind', operator: 'in', values: ['lesson'] },
        { field: 'kind', operator: 'in', values: ['bus', 'lesson'] },
      ]),
    ).toEqual([{ field: 'kind', operator: 'in', values: ['lesson', 'bus'] }]);

    // An operator the field does not offer falls back to its default, rather
    // than emitting a `tags_mode`-shaped value on a scalar column.
    expect(normalizeFilters([{ field: 'host', operator: 'all', values: ['aw'] }])).toEqual([
      { field: 'host', operator: 'in', values: ['aw'] },
    ]);

    // A valueless pill cannot exist — it would be unclearable.
    expect(normalizeFilters([{ field: 'kind', operator: 'in', values: [] }])).toEqual([]);
  });

  it('round-trip through the ?filters= param, so a taxonomy view is a link', () => {
    // AC-3, asserted where the URL contract actually lives rather than in a
    // browser: `filtersParamValue` is what `useUrlState` writes and
    // `resolveFilters` is what a reload reads back. The two new fields take the
    // same path as every other dimension — no field-specific branch — so the
    // property to pin is that the path is lossless for them too.
    const bar: Filter[] = [
      { field: 'kind', operator: 'in', values: ['lesson'] },
      { field: 'host', operator: 'nin', values: ['aw', 'reviewer'] },
    ];
    const encoded = filtersParamValue(bar);
    expect(resolveFilters(JSON.parse(JSON.stringify(encoded)), undefined)).toEqual(bar);
  });

  it('are reachable from the cross-dimension type-ahead', () => {
    // The value hit is what makes the two-level menu cost nothing: typing
    // "reviewer" should offer Host → reviewer without first choosing Host.
    const suggestions = rootSuggestions(
      [
        { facet: 'host', value: 'reviewer', count: 4 },
        { facet: 'kind', value: 'lesson', count: 9 },
      ],
      'reviewer',
    );
    expect(suggestions).toContainEqual({
      kind: 'value',
      field: 'host',
      value: 'reviewer',
      count: 4,
    });
  });
});

describe('FILTER_FIELDS', () => {
  /**
   * The `FacetName` docblock claims the union is one-to-one with `FilterField`
   * now that `kind`/`host` have pills. That claim is load-bearing and invisible:
   * a facet the server emits with no descriptor is NOT a type error, it is a
   * dimension whose rows arrive and are silently ignored — which is exactly the
   * state `kind` and `host` sat in between 00057 and this change. Executed
   * against the server's own enum so adding a facet server-side fails here.
   */
  it('has a pill for every facet the server can emit', () => {
    const mapped = new Set(FILTER_FIELDS.map((d) => d.facet));
    const emitted = MemoryFacetSchema.options;
    expect(emitted.length).toBeGreaterThan(0);
    for (const facet of emitted) {
      expect(mapped, `facet "${facet}" has no FILTER_FIELDS descriptor`).toContain(facet);
    }
    expect(mapped.size).toBe(emitted.length);
  });

  /**
   * The `Partial<ListMemoriesQuery>` return of `filtersToQueryParams` is checked
   * by the compiler for the keys it sets literally — but only the schema knows
   * what the ROUTE accepts. The facets side already has this guard; the memories
   * side did not, which is how a dimension could be mapped to a param the list
   * route ignores and still typecheck.
   */
  it('maps every dimension to a param GET /memories accepts', () => {
    const oneEach: Filter[] = FILTER_FIELDS.map((d) => ({
      field: d.field,
      operator: d.operators[0],
      values: d.field === 'pr' ? ['1'] : ['x'],
    }));
    const params = filtersToQueryParams(oneEach);
    const allowed = new Set(Object.keys(ListMemoriesQuerySchema.shape));

    expect(Object.keys(params).length).toBeGreaterThanOrEqual(FILTER_FIELDS.length);
    for (const key of Object.keys(params)) {
      expect(allowed, `"${key}" is not a ListMemoriesQuery param`).toContain(key);
    }
  });

  it('gives every field a descriptor reachable by name', () => {
    for (const d of FILTER_FIELDS) {
      expect(fieldDescriptor(d.field)).toBe(d);
    }
    expect(fieldDescriptor('nope')).toBeUndefined();
  });

  it('offers a distinct facet per field, so no two dimensions share a catalog', () => {
    const facets = FILTER_FIELDS.map((d) => d.facet);
    expect(new Set(facets).size).toBe(facets.length);
  });

  it('lists a default operator first for every field', () => {
    for (const d of FILTER_FIELDS) {
      expect(d.operators.length).toBeGreaterThan(0);
    }
  });
});
