/**
 * The transport half of the Explorer's filter bar.
 *
 * `filters.spec.ts` pins the MODEL (normalisation, operators, one pill per
 * dimension). This file pins the WIRE, and it exists because the wire is where
 * the bar stopped working: every dimension was comma-joined into one query
 * param, and `ValueListSchema` caps that string at 2048 characters, so a bar
 * with enough values became a `400 Invalid query parameters` — which
 * `LoreExplorer` can only render as "Failed to load memories. Please refresh."
 *
 * Two walls, and the first two tests characterise them against the REAL
 * serialiser and the REAL schema rather than describing them in prose:
 *
 *   1. per-dimension — 2048 characters, ~50-75 production-length host names,
 *      and a different number for every dimension depending on how long its
 *      values happen to be;
 *   2. total URL length — which no schema guards at all, so eight dimensions
 *      each individually under the cap compose a URL past what a gateway will
 *      accept, and that failure arrives with no LoreKit error envelope.
 *
 * Raising the 2048 only moves the first wall and makes the second arrive first,
 * which is why the fix is a body transport (`filtersToBody`) rather than a
 * bigger cap.
 */

import { describe, it, expect } from 'vitest';
import {
  ListMemoriesBodySchema,
  ListMemoriesQuerySchema,
} from '@lorekit/schemas/memory';
import {
  FILTER_FIELDS,
  filtersToBody,
  filtersToFacetBody,
  filtersToQueryParams,
  type Filter,
} from './filters';

/** `n` distinct host names of a realistic production length. */
function hosts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `daily-lorekit-web-report-${i}`);
}

/** The query string the GET transport would actually put on the wire. */
function queryStringFor(bar: Filter[]): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filtersToQueryParams(bar))) {
    params.set(k, String(v));
  }
  return params.toString();
}

describe('the GET transport is the wall (characterisation)', () => {
  it('rejects one dimension past the 2048-character cap', () => {
    const under = filtersToQueryParams([{ field: 'host', operator: 'in', values: hosts(50) }]);
    expect(ListMemoriesQuerySchema.safeParse(under).success).toBe(true);

    const over = filtersToQueryParams([{ field: 'host', operator: 'in', values: hosts(100) }]);
    expect(String(over.host).length).toBeGreaterThan(2048);
    const parsed = ListMemoriesQuerySchema.safeParse(over);
    expect(parsed.success, 'a 100-value dimension must not be sendable as a query param').toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['host']);
  });

  it('still accepts eight dimensions that compose an unsendable URL', () => {
    const values = hosts(60);
    const bar: Filter[] = (['label', 'agent', 'trigger', 'kind', 'host', 'owner', 'repo', 'branch'] as const)
      .map((field) => ({ field, operator: 'in', values })) as Filter[];

    // Every individual param is under the cap, so the schema is happy …
    expect(ListMemoriesQuerySchema.safeParse(filtersToQueryParams(bar)).success).toBe(true);
    // … and the URL is past what a gateway will carry. Nothing guards this.
    expect(queryStringFor(bar).length).toBeGreaterThan(8000);
  });
});

describe('filtersToBody', () => {
  it('sends nothing for an empty bar', () => {
    expect(filtersToBody([])).toEqual({});
  });

  it('maps every label operator onto its tags_mode, values unjoined', () => {
    expect(filtersToBody([{ field: 'label', operator: 'all', values: ['a', 'b'] }]))
      .toEqual({ tags: ['a', 'b'], tags_mode: 'all' });
    expect(filtersToBody([{ field: 'label', operator: 'in', values: ['a'] }]))
      .toEqual({ tags: ['a'], tags_mode: 'any' });
    expect(filtersToBody([{ field: 'label', operator: 'nin', values: ['a'] }]))
      .toEqual({ tags: ['a'], tags_mode: 'none' });
  });

  it('maps each scalar dimension onto its column and mode', () => {
    expect(
      filtersToBody([
        { field: 'agent', operator: 'in', values: ['aw', 'claude'] },
        { field: 'trigger', operator: 'nin', values: ['tool-failure'] },
        { field: 'repo', operator: 'in', values: ['mthines/lorekit'] },
        { field: 'branch', operator: 'in', values: ['main'] },
      ]),
    ).toEqual({
      source_agent: ['aw', 'claude'],
      source_agent_mode: 'in',
      trigger: ['tool-failure'],
      trigger_mode: 'nin',
      origin_repo: ['mthines/lorekit'],
      origin_repo_mode: 'in',
      origin_branch: ['main'],
      origin_branch_mode: 'in',
    });
  });

  it('sends only digits for a pull request, and omits the field when none remain', () => {
    expect(filtersToBody([{ field: 'pr', operator: 'in', values: ['482', 'oops'] }]))
      .toEqual({ origin_pr: ['482'], origin_pr_mode: 'in' });
    expect(filtersToBody([{ field: 'pr', operator: 'in', values: ['oops'] }])).toEqual({});
  });

  it('normalises before translating, so a malformed bar cannot reach the wire', () => {
    expect(
      filtersToBody([
        { field: 'agent', operator: 'all', values: [' aw ', 'aw'] } as unknown as Filter,
      ]),
    ).toEqual({ source_agent: ['aw'], source_agent_mode: 'in' });
  });

  it('carries a comma inside a value, which the query transport cannot', () => {
    const bar: Filter[] = [{ field: 'branch', operator: 'in', values: ['feat/a,b'] }];
    expect(filtersToBody(bar).origin_branch).toEqual(['feat/a,b']);
    // The GET form joins on the comma, so the same value arrives as two.
    expect(filtersToQueryParams(bar).origin_branch).toBe('feat/a,b');
  });

  it('maps every dimension to a field POST /memories/list accepts', () => {
    const oneEach: Filter[] = FILTER_FIELDS.map((d) => ({
      field: d.field,
      operator: d.operators[0],
      values: d.field === 'pr' ? ['1'] : ['x'],
    })) as Filter[];
    const body = filtersToBody(oneEach);
    const allowed = new Set(Object.keys(ListMemoriesBodySchema.shape));

    expect(Object.keys(body).length).toBeGreaterThanOrEqual(FILTER_FIELDS.length);
    for (const key of Object.keys(body)) {
      expect(allowed, `"${key}" is not a ListMemoriesBody field`).toContain(key);
    }
    expect(ListMemoriesBodySchema.safeParse(body).success).toBe(true);
  });

  it('mirrors the list body onto the facets body, so a menu passes its state verbatim', () => {
    const bar: Filter[] = [
      { field: 'label', operator: 'all', values: ['auth', 'perf'] },
      { field: 'agent', operator: 'in', values: ['claude'] },
    ];
    expect(filtersToFacetBody(bar)).toEqual(filtersToBody(bar));
  });
});

describe('the POST transport scales past both walls', () => {
  it('accepts one dimension far beyond what the query string could carry', () => {
    const bar: Filter[] = [{ field: 'host', operator: 'in', values: hosts(500) }];
    const body = filtersToBody(bar);

    expect(body.host).toHaveLength(500);
    const parsed = ListMemoriesBodySchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.[0])).toBe(true);
  });

  it('accepts every dimension loaded at once', () => {
    const values = hosts(200);
    const bar = (['label', 'agent', 'trigger', 'kind', 'host', 'owner', 'repo', 'branch'] as const)
      .map((field) => ({ field, operator: 'in', values })) as Filter[];

    const parsed = ListMemoriesBodySchema.safeParse(filtersToBody(bar));
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.[0])).toBe(true);
  });
});
