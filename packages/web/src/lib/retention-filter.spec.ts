import { describe, it, expect } from 'vitest';
import { ListMemoriesBodySchema } from '@lorekit/schemas/memory';
import { GroomConditionsSchema } from '@lorekit/schemas/retention';
import {
  NO_RETENTION_CONDITIONS,
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

describe('retentionConditionsPhrase', () => {
  it('reads as a sentence, joining active conditions', () => {
    expect(retentionConditionsPhrase({ minAgeDays: 90 })).toBe('older than 90d');
    expect(retentionConditionsPhrase({ minAgeDays: 90, unseenDays: 30 })).toBe(
      'older than 90d · unseen 30d',
    );
    expect(retentionConditionsPhrase({ minAgeDays: 90, unseenDays: 30, maxSeenCount: 1 })).toBe(
      'older than 90d · unseen 30d · seen ≤ 1',
    );
  });

  it('falls back to the control label when nothing is set', () => {
    expect(retentionConditionsPhrase({})).toBe('Age & activity');
  });
});
