/**
 * Contract tests for the OR+AND filter serialiser and the value encoding it
 * shares with the `GET /memories?q=` substring filter.
 *
 * These pin the exact PostgREST expressions that reach the wire, including the
 * field whitelist and the double-quoting that stops a value breaking out of its
 * clause. The expected strings are not a guess: they are the input form
 * PostgREST's own logic-tree parser accepts —
 * `pLogicSingleVal` / `pQuotedValue` in `src/PostgREST/ApiRequest/QueryParams.hs`,
 * identical in v12 and v13 — reached through postgrest-js `.or()`, which appends
 * the expression with `URLSearchParams.append` and therefore delivers these
 * characters verbatim.
 */

import { describe, it, expect } from 'vitest';
import type { FilterGroup } from './common.ts';
import {
  serializeFilterGroup,
  ALLOWED_FILTER_FIELDS,
  likeNeedle,
  quoteFilterValue,
  ilikeClause,
} from './filter.ts';

describe('serializeFilterGroup', () => {
  it('returns no constraint when no filter is supplied', () => {
    expect(serializeFilterGroup(undefined)).toEqual([]);
  });

  it('serialises a single leaf condition', () => {
    expect(serializeFilterGroup({ field: 'scope', op: 'is', value: 'global' })).toEqual([
      'scope.eq."global"',
    ]);
  });

  it.each([
    ['is', 'scope.eq."global"'],
    ['is_not', 'scope.neq."global"'],
    ['contains', 'scope.ilike."%global%"'],
    ['does_not_contain', 'scope.not.ilike."%global%"'],
    ['starts_with', 'scope.ilike."global%"'],
    ['ends_with', 'scope.ilike."%global"'],
  ] as const)('maps the %s operator', (op, expected) => {
    expect(serializeFilterGroup({ field: 'scope', op, value: 'global' })).toEqual([expected]);
  });

  it('maps the null-check operators, which take no value', () => {
    expect(serializeFilterGroup({ field: 'trigger', op: 'is_set' })).toEqual([
      'trigger.not.is.null',
    ]);
    expect(serializeFilterGroup({ field: 'trigger', op: 'is_not_set' })).toEqual([
      'trigger.is.null',
    ]);
  });

  it('emits one conjunct per child of a top-level AND', () => {
    expect(
      serializeFilterGroup({
        and: [
          { field: 'scope', op: 'is', value: 'global' },
          { field: 'key', op: 'contains', value: 'auth' },
        ],
      }),
    ).toEqual(['scope.eq."global"', 'key.ilike."%auth%"']);
  });

  it('collapses a top-level OR into one comma-joined conjunct', () => {
    expect(
      serializeFilterGroup({
        or: [
          { field: 'key', op: 'contains', value: 'auth' },
          { field: 'tags', op: 'contains', value: 'pr-webhook' },
        ],
      }),
    ).toEqual(['key.ilike."%auth%",tags.ilike."%pr-webhook%"']);
  });

  it('expresses an AND nested inside an OR with PostgREST and() syntax', () => {
    expect(
      serializeFilterGroup({
        or: [
          { field: 'scope', op: 'is', value: 'global' },
          {
            and: [
              { field: 'scope', op: 'starts_with', value: 'repo::' },
              { field: 'source_agent', op: 'is', value: 'claude' },
            ],
          },
        ],
      }),
    ).toEqual(['scope.eq."global",and(scope.ilike."repo::%",source_agent.eq."claude")']);
  });

  it('handles the OR-inside-AND shape the API documents', () => {
    expect(
      serializeFilterGroup({
        and: [
          { field: 'scope', op: 'is', value: 'global' },
          {
            or: [
              { field: 'key', op: 'contains', value: 'auth' },
              { field: 'tags', op: 'contains', value: 'pr-webhook' },
            ],
          },
        ],
      }),
    ).toEqual(['scope.eq."global"', 'key.ilike."%auth%",tags.ilike."%pr-webhook%"']);
  });

  it('flattens nested ANDs into sibling conjuncts', () => {
    expect(
      serializeFilterGroup({
        and: [
          { field: 'scope', op: 'is', value: 'global' },
          {
            and: [
              { field: 'key', op: 'starts_with', value: 'a' },
              { field: 'key', op: 'ends_with', value: 'z' },
            ],
          },
        ],
      }),
    ).toEqual(['scope.eq."global"', 'key.ilike."a%"', 'key.ilike."%z"']);
  });

  describe('field whitelist', () => {
    it('exposes the allowed set', () => {
      expect([...ALLOWED_FILTER_FIELDS].sort()).toEqual([
        'key',
        'scope',
        'source_agent',
        'tags',
        'trigger',
        'value',
      ]);
    });

    it.each(['user_id', 'org_id', 'archived_at', 'id', 'expires_at', 'created_by'])(
      'drops a condition on the non-filterable column %s',
      (field) => {
        expect(serializeFilterGroup({ field, op: 'is', value: 'x' })).toEqual([]);
      },
    );

    it('drops only the disallowed branch of an OR, keeping the rest', () => {
      expect(
        serializeFilterGroup({
          or: [
            { field: 'user_id', op: 'is', value: 'someone-else' },
            { field: 'key', op: 'is', value: 'a' },
          ],
        }),
      ).toEqual(['key.eq."a"']);
    });

    it('drops only the disallowed branch of an AND, keeping the rest', () => {
      expect(
        serializeFilterGroup({
          and: [
            { field: 'user_id', op: 'is', value: 'someone-else' },
            { field: 'key', op: 'is', value: 'a' },
          ],
        }),
      ).toEqual(['key.eq."a"']);
    });

    it('emits no constraint when every branch is disallowed', () => {
      expect(serializeFilterGroup({ or: [{ field: 'user_id', op: 'is', value: 'x' }] })).toEqual([]);
      expect(serializeFilterGroup({ and: [{ field: 'user_id', op: 'is', value: 'x' }] })).toEqual([]);
      expect(
        serializeFilterGroup({
          or: [{ and: [{ field: 'org_id', op: 'is_set' }] }],
        }),
      ).toEqual([]);
    });
  });

  describe('value encoding', () => {
    it('quotes a comma so a value cannot add a disjunct', () => {
      expect(serializeFilterGroup({ field: 'key', op: 'is', value: 'a,b' })).toEqual([
        'key.eq."a,b"',
      ]);
    });

    it('quotes parentheses so a value cannot close a group', () => {
      expect(serializeFilterGroup({ field: 'key', op: 'is', value: 'f(x)' })).toEqual([
        'key.eq."f(x)"',
      ]);
    });

    it('neutralises an attempted predicate injection', () => {
      expect(
        serializeFilterGroup({ field: 'value', op: 'contains', value: 'or(user_id.eq.1)' }),
        // `_` is a LIKE single-character wildcard, so it is escaped too.
      ).toEqual([String.raw`value.ilike."%or(user\\_id.eq.1)%"`]);
    });

    it('escapes a double quote so a value cannot close its own quoting', () => {
      // `"` terminates a quoted value unless the parser sees `\"` first, so the
      // injection attempt has to survive as data.
      expect(
        serializeFilterGroup({ field: 'key', op: 'is', value: 'a",user_id.eq."1' }),
      ).toEqual([String.raw`key.eq."a\",user_id.eq.\"1"`]);
    });

    it('doubles a backslash, which is the quoted-value escape character', () => {
      expect(serializeFilterGroup({ field: 'key', op: 'is', value: 'a\\b' })).toEqual([
        String.raw`key.eq."a\\b"`,
      ]);
    });

    it('LIKE-escapes wildcards in a pattern operator but not in an equality', () => {
      // `%` is data in both cases, but only the pattern operators interpret it,
      // so only they escape it — a needless `\%` in an `eq` would be matched
      // literally and find nothing.
      expect(serializeFilterGroup({ field: 'key', op: 'contains', value: '100%' })).toEqual([
        String.raw`key.ilike."%100\\%%"`,
      ]);
      expect(serializeFilterGroup({ field: 'key', op: 'is', value: '100%' })).toEqual([
        'key.eq."100%"',
      ]);
    });

    it('treats a missing value as an empty string rather than throwing', () => {
      expect(serializeFilterGroup({ field: 'key', op: 'is' })).toEqual(['key.eq.""']);
    });
  });

  it('is a total function over deeply nested trees', () => {
    const deep: FilterGroup = {
      and: [
        { or: [{ and: [{ or: [{ field: 'key', op: 'is', value: 'x' }] }] }] },
        { field: 'scope', op: 'is', value: 'global' },
      ],
    };
    expect(serializeFilterGroup(deep)).toEqual(['and(key.eq."x")', 'scope.eq."global"']);
  });
});

describe('likeNeedle', () => {
  it('returns null for absent or whitespace-only input, meaning "no filter"', () => {
    expect(likeNeedle(undefined)).toBeNull();
    expect(likeNeedle(null)).toBeNull();
    expect(likeNeedle('')).toBeNull();
    expect(likeNeedle('   ')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(likeNeedle('  auth  ')).toBe('auth');
  });

  it('escapes the LIKE metacharacters so they match literally', () => {
    expect(likeNeedle('100%')).toBe(String.raw`100\%`);
    expect(likeNeedle('a_b')).toBe(String.raw`a\_b`);
    expect(likeNeedle('a\\b')).toBe(String.raw`a\\b`);
  });

  it('leaves PostgREST reserved characters alone — quoting, not escaping, carries those', () => {
    expect(likeNeedle('a,b(c).d')).toBe('a,b(c).d');
  });

  it('leaves an asterisk literal', () => {
    // PostgREST maps `*` to `%` only for the quantified `like(any)`/`like(all)`
    // forms, which this module never emits.
    expect(likeNeedle('a*b')).toBe('a*b');
  });

  it('preserves unicode', () => {
    expect(likeNeedle('café — 日本語')).toBe('café — 日本語');
  });
});

describe('quoteFilterValue', () => {
  it('always quotes, so the safe path is the only path', () => {
    expect(quoteFilterValue('plain')).toBe('"plain"');
  });

  it('escapes the two characters the quoted-value parser treats as syntax', () => {
    expect(quoteFilterValue('a"b')).toBe(String.raw`"a\"b"`);
    expect(quoteFilterValue('a\\b')).toBe(String.raw`"a\\b"`);
    // A trailing backslash must not escape the closing quote.
    expect(quoteFilterValue('a\\')).toBe(String.raw`"a\\"`);
  });
});

describe('ilikeClause', () => {
  it('builds a contains clause by default', () => {
    expect(ilikeClause('key', 'auth')).toBe('key.ilike."%auth%"');
  });

  it('drops the leading or trailing wildcard for anchored matches', () => {
    expect(ilikeClause('key', 'auth', { prefix: false })).toBe('key.ilike."auth%"');
    expect(ilikeClause('key', 'auth', { suffix: false })).toBe('key.ilike."%auth"');
  });

  it('negates with PostgREST not.ilike, keeping the field first', () => {
    expect(ilikeClause('key', 'auth', { negate: true })).toBe('key.not.ilike."%auth%"');
  });

  it('is the composition both search paths use', () => {
    // The `GET /memories?q=` clause and a `contains` FilterGroup condition must
    // produce byte-identical encodings — that they did not is the drift this
    // helper removes.
    const needle = likeNeedle('a,b%c') as string;
    expect(ilikeClause('key', needle)).toBe(
      serializeFilterGroup({ field: 'key', op: 'contains', value: 'a,b%c' })[0],
    );
  });
});
