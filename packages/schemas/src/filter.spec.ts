/**
 * Contract tests for the OR+AND filter serialiser.
 *
 * These pin the exact PostgREST expressions `POST /memories/search`'s `filter`
 * parameter produces, including the field whitelist and the value encoding
 * that stops a value breaking out of its clause.
 */

import { describe, it, expect } from 'vitest';
import type { FilterGroup } from './common.ts';
import { serializeFilterGroup, ALLOWED_FILTER_FIELDS } from './filter.ts';

describe('serializeFilterGroup', () => {
  it('returns no constraint when no filter is supplied', () => {
    expect(serializeFilterGroup(undefined)).toEqual([]);
  });

  it('serialises a single leaf condition', () => {
    expect(serializeFilterGroup({ field: 'scope', op: 'is', value: 'global' })).toEqual([
      'scope.eq.global',
    ]);
  });

  it.each([
    ['is', 'scope.eq.global'],
    ['is_not', 'scope.neq.global'],
    ['contains', 'scope.ilike.%global%'],
    ['does_not_contain', 'scope.not.ilike.%global%'],
    ['starts_with', 'scope.ilike.global%'],
    ['ends_with', 'scope.ilike.%global'],
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
    ).toEqual(['scope.eq.global', 'key.ilike.%auth%']);
  });

  it('collapses a top-level OR into one comma-joined conjunct', () => {
    expect(
      serializeFilterGroup({
        or: [
          { field: 'key', op: 'contains', value: 'auth' },
          { field: 'tags', op: 'contains', value: 'pr-webhook' },
        ],
      }),
    ).toEqual(['key.ilike.%auth%,tags.ilike.%pr-webhook%']);
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
    ).toEqual(['scope.eq.global,and(scope.ilike.repo::%,source_agent.eq.claude)']);
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
    ).toEqual(['scope.eq.global', 'key.ilike.%auth%,tags.ilike.%pr-webhook%']);
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
    ).toEqual(['scope.eq.global', 'key.ilike.a%', 'key.ilike.%z']);
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
      ).toEqual(['key.eq.a']);
    });

    it('drops only the disallowed branch of an AND, keeping the rest', () => {
      expect(
        serializeFilterGroup({
          and: [
            { field: 'user_id', op: 'is', value: 'someone-else' },
            { field: 'key', op: 'is', value: 'a' },
          ],
        }),
      ).toEqual(['key.eq.a']);
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
    it('percent-encodes commas so a value cannot add a disjunct', () => {
      expect(serializeFilterGroup({ field: 'key', op: 'is', value: 'a,b' })).toEqual(['key.eq.a%2Cb']);
    });

    it('percent-encodes parentheses so a value cannot close a group', () => {
      expect(serializeFilterGroup({ field: 'key', op: 'is', value: 'f(x)' })).toEqual([
        'key.eq.f%28x%29',
      ]);
    });

    it('neutralises an attempted predicate injection', () => {
      expect(
        serializeFilterGroup({ field: 'value', op: 'contains', value: 'or(user_id.eq.1)' }),
      ).toEqual(['value.ilike.%or%28user_id.eq.1%29%']);
    });

    it('treats a missing value as an empty string rather than throwing', () => {
      expect(serializeFilterGroup({ field: 'key', op: 'is' })).toEqual(['key.eq.']);
    });
  });

  it('is a total function over deeply nested trees', () => {
    const deep: FilterGroup = {
      and: [
        { or: [{ and: [{ or: [{ field: 'key', op: 'is', value: 'x' }] }] }] },
        { field: 'scope', op: 'is', value: 'global' },
      ],
    };
    expect(serializeFilterGroup(deep)).toEqual(['and(key.eq.x)', 'scope.eq.global']);
  });
});
