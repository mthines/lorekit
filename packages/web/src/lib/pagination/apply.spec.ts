import { describe, it, expect } from 'vitest';
import { applyKeyset, applyAuditFilters, runPaginatedQuery, type FilterBuilderLike } from './apply';

/** Records every call made against it, chaining itself back (fluent fake). */
function fakeBuilder(): FilterBuilderLike & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const builder: FilterBuilderLike & { calls: [string, unknown[]][] } = {
    calls,
    order: (...args) => {
      calls.push(['order', args]);
      return builder;
    },
    limit: (...args) => {
      calls.push(['limit', args]);
      return builder;
    },
    or: (...args) => {
      calls.push(['or', args]);
      return builder;
    },
    in: (...args) => {
      calls.push(['in', args]);
      return builder;
    },
    ilike: (...args) => {
      calls.push(['ilike', args]);
      return builder;
    },
    gte: (...args) => {
      calls.push(['gte', args]);
      return builder;
    },
    lt: (...args) => {
      calls.push(['lt', args]);
      return builder;
    },
  };
  return builder;
}

describe('applyKeyset', () => {
  it('orders by ts desc, id desc, and limits to pageSize+1, with no cursor -> no .or()', () => {
    const b = fakeBuilder();
    applyKeyset(b, { cursor: null, pageSize: 50 });
    expect(b.calls).toEqual([
      ['order', ['created_at', { ascending: false }]],
      ['order', ['id', { ascending: false }]],
      ['limit', [51]],
    ]);
  });

  it('applies the .or() keyset predicate when a cursor is given', () => {
    const b = fakeBuilder();
    const cursor = { c: '2026-07-01T00:00:00.000Z', id: 'abc' };
    applyKeyset(b, { cursor, pageSize: 10 });
    const orCall = b.calls.find(([name]) => name === 'or');
    expect(orCall).toBeDefined();
    expect(orCall![1][0]).toContain('created_at.lt.2026-07-01T00:00:00.000Z');
    expect(b.calls.at(-1)).toEqual(['limit', [11]]);
  });

  it('honors custom column names', () => {
    const b = fakeBuilder();
    applyKeyset(b, { cursor: null, pageSize: 5, cols: { ts: 'updated_at', id: 'row_id' } });
    expect(b.calls[0]).toEqual(['order', ['updated_at', { ascending: false }]]);
    expect(b.calls[1]).toEqual(['order', ['row_id', { ascending: false }]]);
  });
});

describe('applyAuditFilters', () => {
  it('applies nothing for an empty filter spec', () => {
    const b = fakeBuilder();
    applyAuditFilters(b, { actions: [], needle: null, bounds: {} });
    expect(b.calls).toEqual([]);
  });

  it('applies .in for a non-empty action set', () => {
    const b = fakeBuilder();
    applyAuditFilters(b, { actions: ['memory.create', 'memory.update'], needle: null, bounds: {} });
    expect(b.calls).toEqual([['in', ['action', ['memory.create', 'memory.update']]]]);
  });

  it('applies .ilike wrapped in wildcards for a needle', () => {
    const b = fakeBuilder();
    applyAuditFilters(b, { actions: [], needle: 'foo', bounds: {} });
    expect(b.calls).toEqual([['ilike', ['target', '%foo%']]]);
  });

  it('applies .gte and .lt for date bounds', () => {
    const b = fakeBuilder();
    applyAuditFilters(b, { actions: [], needle: null, bounds: { gte: 'a', lt: 'b' } });
    expect(b.calls).toEqual([
      ['gte', ['created_at', 'a']],
      ['lt', ['created_at', 'b']],
    ]);
  });

  it('combines all three filter kinds in order: in, ilike, gte, lt', () => {
    const b = fakeBuilder();
    applyAuditFilters(b, {
      actions: ['api_key.create'],
      needle: 'x',
      bounds: { gte: 'a', lt: 'b' },
    });
    expect(b.calls.map(([name]) => name)).toEqual(['in', 'ilike', 'gte', 'lt']);
  });
});

describe('runPaginatedQuery', () => {
  it('awaits the built query and yields its { data, error } result', async () => {
    // A supabase-js query builder is itself a thenable resolving to
    // { data, error }; this fake mimics that terminal shape so the awaitable
    // boundary the helper bridges is exercised, not just type-cast.
    const resolved = { data: [{ id: '1' }], error: null };
    const thenable = {
      then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(resolved).then(onFulfilled),
    } as unknown as FilterBuilderLike;

    const { data, error } = await runPaginatedQuery<{ id: string }>(thenable);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: '1' }]);
  });
});
