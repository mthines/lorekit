import { describe, it, expect } from 'vitest';
import { ListMemoriesBodySchema } from '@lorekit/schemas/memory';
import { GroomConditionsSchema } from '@lorekit/schemas/retention';
import { normalizeFilters } from './filters';
import {
  NO_RETENTION_CONDITIONS,
  filtersToGroomDimensionFilters,
  groomConditionsToFilters,
  hasRetentionConditions,
  normalizeRetentionConditions,
  retentionConditionsCount,
  retentionConditionsParamValue,
  retentionConditionsPhrase,
  retentionConditionsToGroomConditions,
  retentionConditionsToListBody,
} from './retention-filter';

describe('normalizeRetentionConditions', () => {
  it('drops a non-object', () => {
    expect(normalizeRetentionConditions(null)).toEqual({});
    expect(normalizeRetentionConditions(undefined)).toEqual({});
    expect(normalizeRetentionConditions('nope')).toEqual({});
    expect(normalizeRetentionConditions(42)).toEqual({});
  });

  it('keeps every in-bounds field', () => {
    expect(normalizeRetentionConditions({ minAgeDays: 90, unseenDays: 30, maxSeenCount: 1 })).toEqual({
      minAgeDays: 90,
      unseenDays: 30,
      maxSeenCount: 1,
    });
  });

  it('drops an out-of-bounds or non-integer field, keeping the rest', () => {
    expect(normalizeRetentionConditions({ minAgeDays: 0, unseenDays: 30 })).toEqual({ unseenDays: 30 });
    expect(normalizeRetentionConditions({ minAgeDays: 3651 })).toEqual({});
    expect(normalizeRetentionConditions({ minAgeDays: 1.5 })).toEqual({});
    expect(normalizeRetentionConditions({ maxSeenCount: -1 })).toEqual({});
  });

  it('accepts maxSeenCount of 0 — the one field whose floor is inclusive of zero', () => {
    expect(normalizeRetentionConditions({ maxSeenCount: 0 })).toEqual({ maxSeenCount: 0 });
  });

  it('coerces a numeric string, matching a round-tripped URL param', () => {
    expect(normalizeRetentionConditions({ minAgeDays: '90' })).toEqual({ minAgeDays: 90 });
  });

  it('drops an unrecognised key', () => {
    expect(normalizeRetentionConditions({ minAgeDays: 90, bogus: 1 })).toEqual({ minAgeDays: 90 });
  });
});

describe('hasRetentionConditions / retentionConditionsCount', () => {
  it('is false/0 for the empty set', () => {
    expect(hasRetentionConditions(NO_RETENTION_CONDITIONS)).toBe(false);
    expect(retentionConditionsCount(NO_RETENTION_CONDITIONS)).toBe(0);
  });

  it('counts each set condition independently, including maxSeenCount: 0', () => {
    expect(retentionConditionsCount({ minAgeDays: 90 })).toBe(1);
    expect(retentionConditionsCount({ minAgeDays: 90, unseenDays: 30 })).toBe(2);
    expect(retentionConditionsCount({ minAgeDays: 90, unseenDays: 30, maxSeenCount: 0 })).toBe(3);
    expect(hasRetentionConditions({ maxSeenCount: 0 })).toBe(true);
  });
});

describe('retentionConditionsParamValue', () => {
  it('drops the param for an empty set and keeps it otherwise', () => {
    expect(retentionConditionsParamValue({})).toBeNull();
    expect(retentionConditionsParamValue({ minAgeDays: 90 })).toEqual({ minAgeDays: 90 });
  });
});

describe('retentionConditionsToListBody / retentionConditionsToGroomConditions', () => {
  it('maps camelCase UI fields to the wire snake_case fields', () => {
    expect(
      retentionConditionsToListBody({ minAgeDays: 90, unseenDays: 30, maxSeenCount: 1 }),
    ).toEqual({ min_age_days: 90, unseen_days: 30, max_seen_count: 1 });
  });

  it('omits an unset field rather than sending it as undefined/null', () => {
    const body = retentionConditionsToListBody({ minAgeDays: 90 });
    expect(body).toEqual({ min_age_days: 90 });
    expect('unseen_days' in body).toBe(false);
    expect('max_seen_count' in body).toBe(false);
  });

  it('emits only fields ListMemoriesBodySchema accepts', () => {
    const body = retentionConditionsToListBody({ minAgeDays: 90, unseenDays: 30, maxSeenCount: 1 });
    const parsed = ListMemoriesBodySchema.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it('emits a shape GroomConditionsSchema — a saved policy\'s conditions — accepts verbatim', () => {
    const conditions = { minAgeDays: 90, unseenDays: 30, maxSeenCount: 1 };
    const groom = retentionConditionsToGroomConditions(conditions);
    expect(GroomConditionsSchema.safeParse(groom).success).toBe(true);
    expect(groom).toEqual({ min_age_days: 90, unseen_days: 30, max_seen_count: 1 });
  });
});

describe('filtersToGroomDimensionFilters', () => {
  it('translates the label operator into tags_mode', () => {
    expect(filtersToGroomDimensionFilters([{ field: 'label', operator: 'all', values: ['perf', 'ci'] }])).toEqual({
      tags: ['perf', 'ci'],
      tags_mode: 'all',
    });
  });

  it('translates every scalar dimension by name', () => {
    expect(
      filtersToGroomDimensionFilters([
        { field: 'host', operator: 'nin', values: ['reviewer'] },
        { field: 'kind', operator: 'in', values: ['lesson'] },
      ]),
    ).toEqual({
      host: ['reviewer'],
      host_mode: 'nin',
      kind: ['lesson'],
      kind_mode: 'in',
    });
  });

  it('drops a non-numeric pr value, matching filtersToBody', () => {
    expect(filtersToGroomDimensionFilters([{ field: 'pr', operator: 'in', values: ['bogus'] }])).toEqual({});
  });

  it('drops the owner dimension — a policy has no ownership filter of its own', () => {
    expect(filtersToGroomDimensionFilters([{ field: 'owner', operator: 'in', values: ['personal'] }])).toEqual({});
  });

  it('emits a shape GroomConditionsSchema accepts', () => {
    const dims = filtersToGroomDimensionFilters([
      { field: 'label', operator: 'in', values: ['perf'] },
      { field: 'repo', operator: 'in', values: ['acme/app'] },
    ]);
    expect(GroomConditionsSchema.safeParse(dims).success).toBe(true);
  });
});

describe('groomConditionsToFilters', () => {
  it('is the reverse of filtersToGroomDimensionFilters for every dimension', () => {
    const filters: import('./filters').Filter[] = [
      { field: 'label', operator: 'all', values: ['perf', 'ci'] },
      { field: 'agent', operator: 'nin', values: ['claude'] },
      { field: 'trigger', operator: 'in', values: ['pr-webhook'] },
      { field: 'kind', operator: 'in', values: ['lesson'] },
      { field: 'host', operator: 'nin', values: ['reviewer'] },
      { field: 'repo', operator: 'in', values: ['acme/app'] },
      { field: 'branch', operator: 'in', values: ['main'] },
      { field: 'pr', operator: 'in', values: ['482'] },
    ];
    const roundTripped = groomConditionsToFilters(filtersToGroomDimensionFilters(filters));
    // normalizeFilters (both this function's output and the reference) orders
    // by dimension, not input order — see `lib/filters.ts`'s `FILTER_FIELDS`.
    expect(roundTripped).toEqual(normalizeFilters(filters));
  });

  it('omits an empty/absent dimension rather than emitting an empty pill', () => {
    expect(groomConditionsToFilters({})).toEqual([]);
    expect(groomConditionsToFilters({ tags: [] })).toEqual([]);
  });

  it('degrades an unrecognised tags_mode to "in" (any), matching normalizeFilters', () => {
    expect(groomConditionsToFilters({ tags: ['perf'], tags_mode: 'bogus' as never })).toEqual([
      { field: 'label', operator: 'in', values: ['perf'] },
    ]);
  });
});

describe('retentionConditionsPhrase', () => {
  it('reads as a sentence, joining active conditions', () => {
    expect(retentionConditionsPhrase({ minAgeDays: 90 })).toBe('created >90d ago');
    expect(retentionConditionsPhrase({ minAgeDays: 90, unseenDays: 30 })).toBe(
      'created >90d ago · unopened >30d',
    );
    expect(retentionConditionsPhrase({ minAgeDays: 90, unseenDays: 30, maxSeenCount: 1 })).toBe(
      'created >90d ago · unopened >30d · seen ≤ 1×',
    );
  });

  it('falls back to the control label when nothing is set', () => {
    expect(retentionConditionsPhrase({})).toBe('Age & activity');
  });
});
