/**
 * Contract tests for the BODY transport — `POST /memories/list`, `/facets` and
 * `/activity`.
 *
 * The query transport encodes a dimension as ONE comma-joined string capped at
 * 2048 characters (`ValueListSchema`), so a filter bar with enough values is a
 * `400 Invalid query parameters` the Explorer can only render as "Failed to
 * load memories". These schemas are the fix: a dimension is a real JSON array,
 * bounded by a count that is a safety limit rather than an accident of how long
 * the values happen to be.
 *
 * What is pinned here is exactly what the query schemas could not promise:
 * a dimension scales to a documented, generous bound; every value is bounded
 * individually so one dimension cannot smuggle an unbounded payload; and a
 * value containing a comma survives, because nothing splits on one.
 */

import { describe, it, expect } from 'vitest';
import {
  ActivityBodySchema,
  FILTER_VALUES_MAX,
  FILTER_VALUE_MAX_CHARS,
  ListFacetsBodySchema,
  ListMemoriesBodySchema,
} from './memory.ts';

/** `n` distinct, production-shaped host names. */
function hosts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `daily-lorekit-web-report-${i}`);
}

describe('ListMemoriesBodySchema', () => {
  it('defaults the same way the query schema does', () => {
    const r = ListMemoriesBodySchema.parse({});
    expect(r.sort).toBe('updated_at');
    expect(r.archived).toBe(false);
    expect(r.limit).toBe(50);
    expect(r.tags_mode).toBe('any');
    expect(r.host_mode).toBe('in');
  });

  it('accepts a dimension at the documented bound', () => {
    const r = ListMemoriesBodySchema.safeParse({ host: hosts(FILTER_VALUES_MAX) });
    expect(r.success, JSON.stringify(r.error?.issues?.[0])).toBe(true);
  });

  it('rejects a dimension one value past the bound, naming the field', () => {
    const r = ListMemoriesBodySchema.safeParse({ host: hosts(FILTER_VALUES_MAX + 1) });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['host']);
  });

  it('bounds each individual value too, so one dimension cannot smuggle a payload', () => {
    const r = ListMemoriesBodySchema.safeParse({ host: ['x'.repeat(FILTER_VALUE_MAX_CHARS + 1)] });
    expect(r.success).toBe(false);
  });

  it('rejects an empty string as a value rather than filtering it silently', () => {
    expect(ListMemoriesBodySchema.safeParse({ host: [''] }).success).toBe(false);
  });

  it('carries a value containing a comma verbatim', () => {
    // Unreachable over `?host=a,b` by construction — the wire format splits on
    // the comma. A JSON array has no such reserved character.
    const r = ListMemoriesBodySchema.parse({ origin_branch: ['feat/a,b'] });
    expect(r.origin_branch).toEqual(['feat/a,b']);
  });

  it('takes real JSON types where the query schema had to coerce strings', () => {
    const r = ListMemoriesBodySchema.parse({ archived: true, limit: 25, expiring_within_days: 7 });
    expect(r.archived).toBe(true);
    expect(r.limit).toBe(25);
    expect(r.expiring_within_days).toBe(7);
    // The string forms the query transport needs are NOT silently accepted:
    // this is a JSON body, so a boolean is a boolean.
    expect(ListMemoriesBodySchema.safeParse({ archived: 'true' }).success).toBe(false);
  });

  it('keeps the limit ceiling the query schema had', () => {
    expect(ListMemoriesBodySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListMemoriesBodySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('accepts every dimension at once', () => {
    const many = hosts(200);
    const r = ListMemoriesBodySchema.safeParse({
      tags: many, source_agent: many, trigger: many, kind: many, host: many,
      origin_repo: many, origin_branch: many, owner: many,
      origin_pr: Array.from({ length: 200 }, (_, i) => String(i)),
    });
    expect(r.success, JSON.stringify(r.error?.issues?.[0])).toBe(true);
  });
});

describe('ListFacetsBodySchema / ActivityBodySchema', () => {
  it('carry the same dimension bound as the list body', () => {
    expect(ListFacetsBodySchema.safeParse({ host: hosts(FILTER_VALUES_MAX) }).success).toBe(true);
    expect(ListFacetsBodySchema.safeParse({ host: hosts(FILTER_VALUES_MAX + 1) }).success).toBe(false);
    expect(ActivityBodySchema.safeParse({ host: hosts(FILTER_VALUES_MAX) }).success).toBe(true);
    expect(ActivityBodySchema.safeParse({ host: hosts(FILTER_VALUES_MAX + 1) }).success).toBe(false);
  });

  it('keep their own non-dimension defaults', () => {
    expect(ListFacetsBodySchema.parse({}).archived).toBe(false);
    expect(ActivityBodySchema.parse({}).bucket).toBe('day');
  });

  it('take the facet narrowing as an array, not a comma list', () => {
    expect(ListFacetsBodySchema.parse({ facets: ['host', 'kind'] }).facets).toEqual(['host', 'kind']);
  });
});
