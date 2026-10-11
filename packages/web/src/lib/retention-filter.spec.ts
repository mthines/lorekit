import { describe, it, expect } from 'vitest';
import {
  ActivityBodySchema,
  ListFacetsBodySchema,
  ListMemoriesBodySchema,
  PivotBodySchema,
} from '@lorekit/schemas/memory';
import { GroomConditionsSchema } from '@lorekit/schemas/retention';
import { normalizeFilters } from './filters';
import {
  NO_RETENTION_CONDITIONS,
  RETENTION_CONDITION_BOUNDS,
  RETENTION_FIELDS,
  RETENTION_MENU_FIELDS,
  filtersToGroomDimensionFilters,
  hasExplorerOnlyConditions,
  policyRetentionConditions,
  retentionEntryValue,
  groomConditionsToFilters,
  hasRetentionConditions,
  normalizeRetentionConditions,
  parseCondition,
  requireRetentionField,
  retentionConditionPlaceholder,
  retentionConditionsCount,
  retentionConditionsParamValue,
  retentionConditionsPhrase,
  retentionConditionsToGroomConditions,
  retentionConditionsToAggregateBody,
  retentionConditionsToListBody,
  retentionFieldMatches,
  isAllScopes,
  policyNameFromRule,
  policyRulePhrase,
  policyScopeLabel,
  POLICY_NAME_MAX,
  retentionValueRows,
  setRetentionCondition,
  type RetentionConditions,
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

  it('keeps the reverse directions (00112), bounded from 1', () => {
    // Additive keys, so every pre-00112 `?retention=` link still resolves to
    // exactly what it meant before.
    expect(
      normalizeRetentionConditions({ openedWithinDays: 7, minSeenCount: 2, minReadCount: 100, minOpenedCount: 10 }),
    ).toEqual({ openedWithinDays: 7, minSeenCount: 2, minReadCount: 100, minOpenedCount: 10 });
    // A floor of 0 narrows nothing, so it is dropped like any out-of-range value.
    expect(normalizeRetentionConditions({ minOpenedCount: 0, openedWithinDays: 0 })).toEqual({});
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
    expect(retentionConditionsCount({ minAgeDays: 90, unseenDays: 30, maxSeenCount: 0, maxReadCount: 0 })).toBe(4);
    expect(
      retentionConditionsCount({
        minAgeDays: 90,
        unseenDays: 30,
        maxSeenCount: 0,
        maxReadCount: 0,
        maxOpenedCount: 0,
      }),
    ).toBe(5);
    expect(hasRetentionConditions({ maxSeenCount: 0 })).toBe(true);
    expect(hasRetentionConditions({ maxReadCount: 0 })).toBe(true);
    // 0 is the WHOLE POINT of this one — "nothing ever chose to open it" — so a
    // falsy-check regression here would silently disable the condition.
    expect(hasRetentionConditions({ maxOpenedCount: 0 })).toBe(true);
  });

  it('counts a reverse direction like any other condition', () => {
    expect(hasRetentionConditions({ minOpenedCount: 10 })).toBe(true);
    expect(retentionConditionsCount({ maxSeenCount: 1, minOpenedCount: 10, openedWithinDays: 7 })).toBe(3);
  });
});

describe('hasExplorerOnlyConditions / policyRetentionConditions', () => {
  it('is true only for a condition a retention policy cannot carry', () => {
    expect(hasExplorerOnlyConditions({ minAgeDays: 90, maxOpenedCount: 0 })).toBe(false);
    for (const field of ['openedWithinDays', 'minSeenCount', 'minReadCount', 'minOpenedCount'] as const) {
      expect(hasExplorerOnlyConditions({ [field]: 1 }), field).toBe(true);
    }
  });

  it('keeps just the five policy conditions', () => {
    expect(
      policyRetentionConditions({ minAgeDays: 90, maxOpenedCount: 0, minReadCount: 100, openedWithinDays: 7 }),
    ).toEqual({ minAgeDays: 90, maxOpenedCount: 0 });
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

  it('carries maxReadCount as its own wire field, independent of max_seen_count', () => {
    expect(retentionConditionsToListBody({ maxReadCount: 0 })).toEqual({ max_read_count: 0 });
    expect(retentionConditionsToListBody({ maxSeenCount: 1, maxReadCount: 3 })).toEqual({
      max_seen_count: 1,
      max_read_count: 3,
    });
  });

  it('carries maxOpenedCount as a THIRD counter, distinct from the other two', () => {
    // The three count different things (writes / all reads / deliberate
    // fetches). Collapsing any pair onto one wire field would make a "never
    // chosen" filter silently mean "never delivered", which matches nothing.
    expect(retentionConditionsToListBody({ maxOpenedCount: 0 })).toEqual({ max_opened_count: 0 });
    expect(
      retentionConditionsToListBody({ maxSeenCount: 1, maxReadCount: 300, maxOpenedCount: 0 }),
    ).toEqual({ max_seen_count: 1, max_read_count: 300, max_opened_count: 0 });
  });

  it('omits an unset field rather than sending it as undefined/null', () => {
    const body = retentionConditionsToListBody({ minAgeDays: 90 });
    expect(body).toEqual({ min_age_days: 90 });
    expect('unseen_days' in body).toBe(false);
    expect('max_seen_count' in body).toBe(false);
    expect('max_read_count' in body).toBe(false);
    expect('max_opened_count' in body).toBe(false);
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

  it('maps the reverse directions to their own wire fields on the LIST body', () => {
    const body = retentionConditionsToListBody({
      openedWithinDays: 7,
      minSeenCount: 2,
      minReadCount: 100,
      minOpenedCount: 10,
    });
    expect(body).toEqual({ opened_within_days: 7, min_seen_count: 2, min_read_count: 100, min_opened_count: 10 });
    // Read back off the parsed output: the schema is not `.strict()`, so a
    // success-only check would pass a route that silently dropped them.
    const parsed = ListMemoriesBodySchema.parse(body);
    expect([parsed.opened_within_days, parsed.min_seen_count, parsed.min_read_count, parsed.min_opened_count]).toEqual([
      7, 2, 100, 10,
    ]);
  });

  it('never hands a reverse direction to a POLICY — GroomConditions has no field for it', () => {
    const groom = retentionConditionsToGroomConditions({ maxOpenedCount: 0, minOpenedCount: 10, openedWithinDays: 7 });
    expect(groom).toEqual({ max_opened_count: 0 });
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
      'created >90d ago · unopened >30d · written ≤ 1×',
    );
  });

  // The three counters measure different things and sit next to each other in
  // the phrase, so none may be called "seen" — that word is what made a
  // write-recurrence condition read as a usage one — and "delivered" must not
  // collapse into "chosen", which is the whole distinction 00105 adds.
  it('names the three counters apart — written / delivered / chosen', () => {
    expect(retentionConditionsPhrase({ maxSeenCount: 1, maxReadCount: 0 })).toBe(
      'written ≤ 1× · delivered ≤ 0×',
    );
    expect(retentionConditionsPhrase({ maxReadCount: 300, maxOpenedCount: 0 })).toBe(
      'delivered ≤ 300× · chosen ≤ 0×',
    );
    expect(retentionConditionsPhrase({ maxReadCount: 5 })).not.toContain('seen');
    expect(retentionConditionsPhrase({ maxReadCount: 5 })).not.toContain('chosen');
  });

  it('falls back to the control label when nothing is set', () => {
    expect(retentionConditionsPhrase({})).toBe('Age & activity');
  });
});

describe('retentionConditionPlaceholder', () => {
  // A bare number in a number input is indistinguishable from a typed value —
  // the whole reason two blank fields were read as active ones. The `e.g. `
  // prefix is the fix, so assert it rather than just the example number.
  it('prefixes the example so it cannot be misread as a set value', () => {
    expect(retentionConditionPlaceholder('minAgeDays')).toBe('e.g. 7');
    expect(retentionConditionPlaceholder('unseenDays')).toBe('e.g. 90');
    expect(retentionConditionPlaceholder('maxSeenCount')).toBe('e.g. 1');
    expect(retentionConditionPlaceholder('maxOpenedCount')).toBe('e.g. 0');
  });

  it('is never a bare number for any condition', () => {
    for (const field of [
      'minAgeDays',
      'unseenDays',
      'maxSeenCount',
      'maxReadCount',
      'maxOpenedCount',
    ] as const) {
      expect(retentionConditionPlaceholder(field)).toMatch(/^e\.g\. \d+$/);
    }
  });

  // Measured against the live store: `max_read_count <= 5` matched nothing,
  // the first non-empty result appeared at 26, and 400 matched everything. A
  // suggestion below that floor hands the reader a filter that always returns
  // nothing, which is indistinguishable from a broken one.
  it('suggests a read-count example inside the range that can actually match', () => {
    const example = Number(retentionConditionPlaceholder('maxReadCount').replace('e.g. ', ''));
    expect(example).toBeGreaterThanOrEqual(26);
  });
});

/**
 * Migration 00108: the three AGGREGATE routes must accept the same thresholds
 * the list does. Before it, `/facets`, `/activity` and `/pivot` had no such
 * parameters at all, so setting one narrowed the Explorer's rows and left every
 * number describing them — facet counts, stat cards, matrix cells — counting
 * the un-narrowed population.
 *
 * The assertions below deliberately parse against the REAL aggregate schemas
 * rather than comparing to `retentionConditionsToListBody`'s output: proving the
 * two functions agree with each other is worthless if both emit a field the
 * aggregate route rejects.
 */
describe('retentionConditionsToAggregateBody', () => {
  it('maps the same camelCase fields to the same wire fields the list uses', () => {
    // Not asserted by delegation: the point is that a route which stopped
    // taking one of the five would fail HERE, at the schema.
    expect(
      retentionConditionsToAggregateBody({
        minAgeDays: 90,
        unseenDays: 30,
        maxSeenCount: 1,
        maxReadCount: 300,
        maxOpenedCount: 0,
      }),
    ).toEqual({
      min_age_days: 90,
      unseen_days: 30,
      max_seen_count: 1,
      max_read_count: 300,
      max_opened_count: 0,
    });
  });

  it('carries the reverse directions to all three aggregates, so the counts describe the list (00112)', () => {
    const body = retentionConditionsToAggregateBody({ openedWithinDays: 7, minOpenedCount: 10 });
    expect(body).toEqual({ opened_within_days: 7, min_opened_count: 10 });
    for (const parsed of [
      ListFacetsBodySchema.parse(body),
      ActivityBodySchema.parse(body),
      PivotBodySchema.parse({ row: 'host', col: 'kind', ...body }),
    ]) {
      expect([parsed.opened_within_days, parsed.min_opened_count]).toEqual([7, 10]);
    }
  });

  it('emits fields ALL THREE aggregate schemas actually CARRY', () => {
    const body = retentionConditionsToAggregateBody({
      minAgeDays: 7,
      unseenDays: 90,
      maxOpenedCount: 0,
    });

    // Asserting `safeParse(...).success` alone would be VACUOUS here, and that
    // is worth spelling out: these schemas are not `.strict()`, so zod STRIPS
    // an unrecognised key and still reports success. A route with no retention
    // parameters at all — the pre-00108 state, the exact bug — would pass a
    // success-only check while silently discarding every threshold. So each
    // field is read back off the PARSED output, which is the only thing that
    // proves the schema carries it.
    const carried = (parsed: unknown) => {
      const data = parsed as Record<string, unknown>;
      return {
        min_age_days: data.min_age_days,
        unseen_days: data.unseen_days,
        max_opened_count: data.max_opened_count,
      };
    };
    const expected = { min_age_days: 7, unseen_days: 90, max_opened_count: 0 };

    expect(carried(ListFacetsBodySchema.parse(body))).toEqual(expected);
    expect(carried(ActivityBodySchema.parse(body))).toEqual(expected);
    // Pivot requires its two axes; the thresholds must not interfere with them.
    expect(carried(PivotBodySchema.parse({ row: 'host', col: 'kind', ...body }))).toEqual(expected);
  });

  it('omits an unset field, so a blank input never sends a threshold', () => {
    // The whole set being absent is what "not narrowed" means on the wire — an
    // explicit null would be read by the RPC as a filter of null, and a `0`
    // would be a real and very aggressive filter.
    const body = retentionConditionsToAggregateBody({});
    expect(body).toEqual({});
    for (const field of [
      'min_age_days',
      'unseen_days',
      'max_seen_count',
      'max_read_count',
      'max_opened_count',
    ]) {
      expect(field in body).toBe(false);
    }
  });

  it('carries maxOpenedCount: 0 rather than dropping it as falsy', () => {
    // `max_opened_count => 0` ("nothing ever chose this lesson") is the most
    // useful threshold in the set — migration 00105 exists for it. A truthiness
    // check anywhere on this path turns it into no filter at all, which reads
    // as the feature being broken rather than as a bug.
    const body = retentionConditionsToAggregateBody({ maxOpenedCount: 0 });
    expect(body).toEqual({ max_opened_count: 0 });
    // Read back off the parsed output, not `.success` — see the note above on
    // why a non-strict schema makes a success-only assertion vacuous.
    expect(ListFacetsBodySchema.parse(body).max_opened_count).toBe(0);
  });
});

// ── The filter menu's age & activity entries ─────────────────────────────────

describe('RETENTION_FIELDS', () => {
  it('covers every condition exactly once, and in a stable order', () => {
    // The pill order and `retentionConditionsPhrase`'s fragment order are this
    // one array, so a field added to `RetentionConditions` without an entry
    // here is a condition the URL can carry and the UI can never show or clear.
    // Each reverse direction sits right after the row it reverses.
    expect(RETENTION_FIELDS.map((d) => d.field)).toEqual([
      'minAgeDays',
      'unseenDays',
      'openedWithinDays',
      'maxSeenCount',
      'minSeenCount',
      'maxReadCount',
      'minReadCount',
      'maxOpenedCount',
      'minOpenedCount',
    ]);
    expect(RETENTION_FIELDS.map((d) => d.field).sort()).toEqual(
      Object.keys(RETENTION_CONDITION_BOUNDS).sort(),
    );
  });

  it('lists five menu rows — one per metadata row, never one per direction', () => {
    expect(RETENTION_MENU_FIELDS).toEqual([
      'minAgeDays',
      'unseenDays',
      'maxSeenCount',
      'maxReadCount',
      'maxOpenedCount',
    ]);
  });

  it('pairs each reverse direction with its row symmetrically, under the same label', () => {
    for (const d of RETENTION_FIELDS) {
      if (d.opposite === undefined) continue;
      const other = requireRetentionField(d.opposite);
      expect(other.opposite, d.field).toBe(d.field);
      expect(other.entry, d.field).toBe(d.entry);
      expect(other.label, d.field).toBe(d.label);
      // A toggle with two identical segments would be unreadable.
      expect(other.directionLabel, d.field).not.toBe(d.directionLabel);
    }
    // Created has no reverse: the date range picker already answers "created
    // within", and a second spelling of it would be two controls for one fact.
    expect(requireRetentionField('minAgeDays').opposite).toBeUndefined();
  });

  it('words the reverse directions as "or more" / "within", so a pill carries its direction', () => {
    expect(requireRetentionField('minOpenedCount').formatValue(10)).toBe('10 times or more');
    expect(requireRetentionField('minOpenedCount').formatValue(1)).toBe('At least once');
    expect(requireRetentionField('minReadCount').formatValue(500)).toBe('500 times or more');
    expect(requireRetentionField('openedWithinDays').formatValue(7)).toBe('Within 7 days');
    expect(requireRetentionField('openedWithinDays').formatValue(1)).toBe('Within 1 day');
  });

  it('offers only in-bounds presets', () => {
    // A preset that `normalizeRetentionConditions` would drop is a row that
    // applies a filter and then silently reverts on the next read of the URL.
    for (const { field, presets } of RETENTION_FIELDS) {
      for (const preset of presets) {
        expect(parseCondition(preset, RETENTION_CONDITION_BOUNDS[field])).toBe(preset);
      }
    }
  });

  it('leads Chosen with 0 and keeps 0 out of the other counters', () => {
    // `maxOpenedCount: 0` is migration 00105's whole point. The other two
    // counters cannot usefully be 0 — a memory exists because it was written,
    // and `max_read_count <= 5` matched nothing at all on the live store.
    expect(requireRetentionField('maxOpenedCount').presets[0]).toBe(0);
    expect(requireRetentionField('maxSeenCount').presets).not.toContain(0);
    expect(requireRetentionField('maxReadCount').presets).not.toContain(0);
  });

  it('captions Chosen: 0 as never chosen rather than as a count', () => {
    expect(requireRetentionField('maxOpenedCount').formatValue(0)).toBe('Never chosen');
    expect(requireRetentionField('maxOpenedCount').formatValue(1)).toBe('1 time or fewer');
    expect(requireRetentionField('minAgeDays').formatValue(1)).toBe('More than 1 day ago');
    expect(requireRetentionField('minAgeDays').formatValue(30)).toBe('More than 30 days ago');
  });
});

describe('requireRetentionField', () => {
  it('throws on an unknown field rather than returning undefined', () => {
    expect(() => requireRetentionField('bogus' as never)).toThrow(/Unknown retention field/);
  });
});

describe('retentionFieldMatches', () => {
  it('offers every menu row, in order, with no query', () => {
    expect(retentionFieldMatches('')).toEqual(RETENTION_MENU_FIELDS);
    expect(retentionFieldMatches('   ')).toEqual(RETENTION_MENU_FIELDS);
  });

  it('finds a row by the reverse question too', () => {
    // "most used" is the question 00112 exists for; it must land on the row
    // that answers it, never on a second row per direction.
    expect(retentionFieldMatches('most')).toEqual(['maxOpenedCount']);
    expect(retentionFieldMatches('recent')).toEqual(['unseenDays']);
  });

  it('ranks label hits above keyword hits', () => {
    // `c` starts both "Created" and "Chosen", and also the keyword "cost" on
    // Delivered. A keyword must never outrank a label, or typing the first
    // letter of the row you want surfaces a different row first.
    expect(retentionFieldMatches('c').slice(0, 2)).toEqual(['minAgeDays', 'maxOpenedCount']);
  });

  it('finds an entry by the question rather than its label', () => {
    expect(retentionFieldMatches('never')).toEqual(['maxOpenedCount']);
    expect(retentionFieldMatches('stale')).toEqual(['unseenDays']);
    expect(retentionFieldMatches('cost')).toEqual(['maxReadCount']);
  });

  it('returns nothing for a query that matches no entry', () => {
    expect(retentionFieldMatches('zzz')).toEqual([]);
  });
});

describe('retentionValueRows', () => {
  it('lists the presets with no query, none of them custom', () => {
    expect(retentionValueRows('maxOpenedCount', '')).toEqual([
      { value: 0, custom: false },
      { value: 1, custom: false },
      { value: 2, custom: false },
      { value: 5, custom: false },
    ]);
  });

  it('matches presets by NUMERIC PREFIX, so typing toward a value narrows', () => {
    // `3` keeps 30 and 365 — a reader typing toward one of them — behind the
    // typed value itself, which is a legal threshold in its own right. What it
    // must NOT do is match on the rendered row text: `days` appears in every
    // one of this field's labels and matches nothing.
    expect(retentionValueRows('minAgeDays', '3').map((r) => r.value)).toEqual([3, 30, 365]);
    expect(retentionValueRows('minAgeDays', '18').map((r) => r.value)).toEqual([18, 180]);
    expect(retentionValueRows('minAgeDays', 'days')).toEqual([]);
  });

  it('offers a typed value that is not a preset, leading and labelled custom', () => {
    expect(retentionValueRows('minAgeDays', '45')).toEqual([{ value: 45, custom: true }]);
  });

  it('does not duplicate a typed value that IS a preset', () => {
    expect(retentionValueRows('minAgeDays', '30')).toEqual([{ value: 30, custom: false }]);
  });

  it('offers no custom row for a value normalization would drop', () => {
    // Out of bounds, non-integer, and non-numeric all reach the menu's empty
    // state rather than applying a threshold that vanishes on the next read of
    // `?retention=`.
    expect(retentionValueRows('minAgeDays', '0')).toEqual([]);
    expect(retentionValueRows('minAgeDays', '4000')).toEqual([]);
    expect(retentionValueRows('minAgeDays', '7.5')).toEqual([]);
    expect(retentionValueRows('maxSeenCount', 'one')).toEqual([]);
  });

  it('offers 0 for the one field whose floor is zero', () => {
    expect(retentionValueRows('maxOpenedCount', '0')).toEqual([{ value: 0, custom: false }]);
    expect(retentionValueRows('maxSeenCount', '0')).toEqual([{ value: 0, custom: true }]);
  });

  it('gives an applied value that is NOT a preset a leading row of its own', () => {
    // Reopening `Created` set to a typed 5 must show that 5, or the list denies
    // the value the pill beside it is displaying and nothing reads as selected.
    expect(retentionValueRows('minAgeDays', '', 5)).toEqual([
      { value: 5, custom: true },
      { value: 7, custom: false },
      { value: 30, custom: false },
      { value: 90, custom: false },
      { value: 180, custom: false },
      { value: 365, custom: false },
    ]);
  });

  it('does not duplicate an applied value that IS a preset', () => {
    expect(retentionValueRows('minAgeDays', '', 30)).toEqual(retentionValueRows('minAgeDays', ''));
  });

  it('leaves 0 applied on the zero-floor field as its own preset row', () => {
    // `maxOpenedCount: 0` is the most-used threshold in the set and IS a preset,
    // so it must not acquire a second row labelled custom.
    expect(retentionValueRows('maxOpenedCount', '', 0)).toEqual(
      retentionValueRows('maxOpenedCount', ''),
    );
  });

  it('ignores the applied value once a query narrows the list', () => {
    // The query is the reader's live question; the applied value is the state
    // they are changing. A `3` must not resurrect an unrelated applied 5.
    expect(retentionValueRows('minAgeDays', '3', 5).map((r) => r.value)).toEqual([3, 30, 365]);
  });
});

describe('retentionEntryValue', () => {
  it('reports whichever direction a row holds', () => {
    expect(retentionEntryValue({ maxOpenedCount: 0 }, 'maxOpenedCount')).toEqual({ field: 'maxOpenedCount', value: 0 });
    expect(retentionEntryValue({ minOpenedCount: 10 }, 'maxOpenedCount')).toEqual({ field: 'minOpenedCount', value: 10 });
    expect(retentionEntryValue({ openedWithinDays: 7 }, 'unseenDays')).toEqual({ field: 'openedWithinDays', value: 7 });
    expect(retentionEntryValue({}, 'maxOpenedCount')).toBeNull();
    expect(retentionEntryValue({ minOpenedCount: 10 }, 'minAgeDays')).toBeNull();
  });

  it('prefers the retention direction when a hand-edited link carries both', () => {
    expect(retentionEntryValue({ maxSeenCount: 5, minSeenCount: 2 }, 'maxSeenCount')).toEqual({
      field: 'maxSeenCount',
      value: 5,
    });
  });
});

describe('retentionValueRows — reverse directions', () => {
  it('offers the reverse direction its own presets, and a typed value in that direction', () => {
    expect(retentionValueRows('minOpenedCount', '').map((r) => r.value)).toEqual([1, 5, 10, 25]);
    // Typed values are the custom-value input in BOTH directions.
    expect(retentionValueRows('minOpenedCount', '40')).toEqual([{ value: 40, custom: true }]);
    expect(retentionValueRows('openedWithinDays', '14')).toEqual([{ value: 14, custom: true }]);
  });

  it('offers no typed 0 for a floor, since a floor of 0 narrows nothing', () => {
    expect(retentionValueRows('minOpenedCount', '0')).toEqual([]);
  });
});

describe('setRetentionCondition', () => {
  it('clears the same row\'s opposite direction when setting a value', () => {
    // One direction per row: switching `Chosen` from "at most 5" to "at least
    // 10" must REPLACE the condition, not narrow to the empty range 10..5.
    expect(setRetentionCondition({ maxOpenedCount: 5, minAgeDays: 30 }, 'minOpenedCount', 10)).toEqual({
      minAgeDays: 30,
      minOpenedCount: 10,
    });
    expect(setRetentionCondition({ openedWithinDays: 7 }, 'unseenDays', 90)).toEqual({ unseenDays: 90 });
  });

  it('leaves the opposite alone when CLEARING, so a pill × removes only its own pill', () => {
    expect(setRetentionCondition({ maxSeenCount: 5, minSeenCount: 2 }, 'minSeenCount', undefined)).toEqual({
      maxSeenCount: 5,
    });
  });

  it('sets a field without mutating the input', () => {
    const before: RetentionConditions = { minAgeDays: 30 };
    const after = setRetentionCondition(before, 'maxOpenedCount', 0);
    expect(after).toEqual({ minAgeDays: 30, maxOpenedCount: 0 });
    expect(before).toEqual({ minAgeDays: 30 });
  });

  it('replaces rather than accumulates — a threshold holds one value', () => {
    expect(setRetentionCondition({ minAgeDays: 30 }, 'minAgeDays', 90)).toEqual({ minAgeDays: 90 });
  });

  it('removes the key on undefined, so the param drops rather than carrying a null', () => {
    const cleared = setRetentionCondition({ minAgeDays: 30, unseenDays: 7 }, 'minAgeDays', undefined);
    expect(cleared).toEqual({ unseenDays: 7 });
    expect('minAgeDays' in cleared).toBe(false);
  });

  it('sets 0 rather than treating it as a clear', () => {
    // The one value a truthiness check would swallow, and the most useful one
    // in the set (00105).
    expect(setRetentionCondition({}, 'maxOpenedCount', 0)).toEqual({ maxOpenedCount: 0 });
    expect(hasRetentionConditions(setRetentionCondition({}, 'maxOpenedCount', 0))).toBe(true);
  });
});

describe('policyScopeLabel / isAllScopes', () => {
  it('reads `global` as every scope, because that is what the groom RPC does', () => {
    expect(isAllScopes('global')).toBe(true);
    expect(policyScopeLabel('global')).toBe('all scopes');
  });

  it('leaves a named scope as itself', () => {
    expect(isAllScopes('repo::mthines/lorekit')).toBe(false);
    expect(policyScopeLabel('repo::mthines/lorekit')).toBe('repo::mthines/lorekit');
  });

  it('is not fooled by surrounding whitespace', () => {
    expect(isAllScopes('  global  ')).toBe(true);
    expect(policyScopeLabel('  repo::a/b  ')).toBe('repo::a/b');
  });
});

describe('policyRulePhrase', () => {
  it('joins the conditions in the menu order', () => {
    expect(policyRulePhrase({ minAgeDays: 90, maxOpenedCount: 0 })).toBe(
      'created >90d ago · chosen ≤ 0×',
    );
  });

  it('is EMPTY for a rule that narrows by nothing', () => {
    // Not `retentionConditionsPhrase`'s 'Age & activity' fallback — that is a
    // menu label, and it would read as a condition inside a policy name.
    expect(policyRulePhrase({})).toBe('');
    expect(retentionConditionsPhrase({})).toBe('Age & activity');
  });

  it('appends the filter bar, and contributes nothing for an empty one', () => {
    // `filtersPhrase([])` answers 'Add filter' — a button label. It must never
    // reach a name.
    expect(policyRulePhrase({}, [])).toBe('');
    expect(policyRulePhrase({ minAgeDays: 7 }, [])).toBe('created >7d ago');
    expect(
      policyRulePhrase({}, [{ field: 'host', operator: 'in', values: ['reviewer'] }]),
    ).toContain('reviewer');
  });

  it('names only what a policy can carry, never a reverse direction', () => {
    expect(policyRulePhrase({ maxOpenedCount: 0, minReadCount: 100 })).toBe('chosen ≤ 0×');
  });
});

describe('policyNameFromRule', () => {
  it('names the rule and the scope it runs over', () => {
    expect(policyNameFromRule('repo::mthines/lorekit', { minAgeDays: 90, maxOpenedCount: 0 })).toBe(
      'created >90d ago · chosen ≤ 0× in repo::mthines/lorekit',
    );
  });

  it('says what an unnarrowed all-scopes rule actually does', () => {
    expect(policyNameFromRule('global', {})).toBe('Every unprotected lesson in all scopes');
  });

  it('fits the schema bound, which a wide filter bar can outrun', () => {
    const values = Array.from({ length: 200 }, (_, i) => `label-number-${i}`);
    const name = policyNameFromRule('repo::mthines/lorekit', { minAgeDays: 90 }, [
      { field: 'label', operator: 'in', values },
    ]);
    expect(name.length).toBeLessThanOrEqual(POLICY_NAME_MAX);
    expect(name.endsWith('…')).toBe(true);
    // Still a legal name — `min(1)` at the other end of the same schema field.
    expect(name.length).toBeGreaterThan(0);
  });
});
