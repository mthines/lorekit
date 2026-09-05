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
  PivotBodySchema,
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

/**
 * The aggregate routes must accept the SAME retention thresholds the list does
 * (migration 00108). This is the parity that was missing: before it, setting
 * `max_opened_count` moved `POST /memories/list` and left `/facets`,
 * `/activity` and `/pivot` counting the un-narrowed population, so the
 * Explorer's facet counts, stat cards and matrix all disagreed with the list
 * they described. Asserted per-schema rather than by reading the shared spread,
 * because a spread that stops being applied to one schema is exactly the
 * regression this has to catch.
 */
describe('retention thresholds on the aggregate body schemas', () => {
  const AGGREGATES = {
    ListFacetsBodySchema,
    ActivityBodySchema,
    PivotBodySchema,
  } as const;

  /** A pivot body needs its two required axes; the others take an empty base. */
  function base(name: keyof typeof AGGREGATES): Record<string, unknown> {
    return name === 'PivotBodySchema' ? { row: 'host', col: 'kind' } : {};
  }

  const THRESHOLDS = [
    ['min_age_days', 7],
    ['unseen_days', 90],
    ['max_seen_count', 1],
    ['max_read_count', 200],
    ['max_opened_count', 0],
  ] as const;

  for (const name of Object.keys(AGGREGATES) as (keyof typeof AGGREGATES)[]) {
    describe(name, () => {
      it.each(THRESHOLDS)('accepts %s and preserves the value', (field, value) => {
        const r = AGGREGATES[name].safeParse({ ...base(name), [field]: value });
        expect(r.success, JSON.stringify(r.error?.issues?.[0])).toBe(true);
        expect((r.data as Record<string, unknown>)[field]).toBe(value);
      });

      it('leaves every threshold undefined when none is sent', () => {
        const parsed = AGGREGATES[name].parse(base(name)) as Record<string, unknown>;
        for (const [field] of THRESHOLDS) expect(parsed[field]).toBeUndefined();
      });

      it('shares the list body’s bounds rather than inventing its own', () => {
        // `max_opened_count` admits 0 ("never chosen") — the whole point of
        // 00105 — while `min_age_days` starts at 1. A schema that flipped these
        // would silently disagree with `lorekit_memory_list`.
        expect(AGGREGATES[name].safeParse({ ...base(name), max_opened_count: 0 }).success).toBe(true);
        expect(AGGREGATES[name].safeParse({ ...base(name), min_age_days: 0 }).success).toBe(false);
        expect(AGGREGATES[name].safeParse({ ...base(name), min_age_days: 3651 }).success).toBe(false);
        expect(AGGREGATES[name].safeParse({ ...base(name), max_read_count: 100_001 }).success).toBe(false);
        // Real JSON types over a body — a numeric string is a 400 here, and is
        // only coerced on the query transport.
        expect(AGGREGATES[name].safeParse({ ...base(name), min_age_days: '7' }).success).toBe(false);
      });
    });
  }

  it('gives /facets and /pivot the created_at window too, so `All time` narrows a count', () => {
    const window = { created_since: '2026-01-01T00:00:00Z', created_until: '2026-02-01T00:00:00Z' };
    expect(ListFacetsBodySchema.safeParse(window).success).toBe(true);
    expect(PivotBodySchema.safeParse({ row: 'host', col: 'kind', ...window }).success).toBe(true);
    // `/activity` needs no separate pair: its own `since`/`until` already bound
    // `created_at`, and a second window would be two ways to say one thing.
    expect(ActivityBodySchema.parse({ since: window.created_since }).since).toBe(window.created_since);
  });
});
