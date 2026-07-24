import { describe, it, expect, vi } from 'vitest';
import { search } from './search.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

type FakeRow = { key: string; value: string; scope: string; tags: string[] };

/**
 * Build a minimal Supabase mock that resolves a textSearch chain ending in
 * .order() with the supplied rows.
 */
function makeDb(rows: FakeRow[], error: null | { message: string } = null) {
  const terminalValue = { data: rows, error };

  // The chain can be: .textSearch → .limit → .overlaps? → .or? → .order
  // We build a lazy chain where every call returns the same proxy, and the
  // final .order resolves the promise.
  const chain: Record<string, unknown> = {};
  const resolve = () => Promise.resolve(terminalValue);
  const self = () => chainProxy;
  const chainProxy = new Proxy(chain, {
    get(_target, prop) {
      if (prop === 'order') return resolve;
      return self;
    },
  }) as unknown as ReturnType<SupabaseClient['from']>;

  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        textSearch: vi.fn().mockReturnValue(chainProxy),
      }),
    }),
  } as unknown as SupabaseClient;
}

// ── search ────────────────────────────────────────────────────────────────────

describe('search', () => {
  it('returns entries with positional rank', async () => {
    const rows: FakeRow[] = [
      { key: 'k1', value: 'worktree isolation tip', scope: 'global', tags: [] },
      { key: 'k2', value: 'worktree naming tip', scope: 'repo::mthines/gw-tools', tags: ['skill::aw'] },
    ];
    const db = makeDb(rows);
    const result = await search(db, { q: 'worktree' });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.rank).toBeGreaterThan(result.entries[1]!.rank);
  });

  it('returns empty entries when no rows match', async () => {
    const db = makeDb([]);
    const result = await search(db, { q: 'unfindable query' });
    expect(result.entries).toEqual([]);
  });

  it('assigns a descending positional rank starting at 1.0', async () => {
    const rows: FakeRow[] = [
      { key: 'k1', value: 'first', scope: 'global', tags: [] },
      { key: 'k2', value: 'second', scope: 'global', tags: [] },
    ];
    const db = makeDb(rows);
    const result = await search(db, { q: 'test' });
    expect(result.entries[0]!.rank).toBe(1);
    expect(result.entries[1]!.rank).toBeCloseTo(0.95);
  });

  it('forwards scope, tags and limit without throwing', async () => {
    const db = makeDb([]);
    await expect(
      search(db, {
        q: 'worktree',
        scopes: ['global', 'repo::mthines/*'],
        tags: ['skill::aw'],
        limit: 5,
      }),
    ).resolves.toMatchObject({ entries: [] });
  });

  it('throws ZodError when q is missing', async () => {
    const db = makeDb([]);
    await expect(search(db, {})).rejects.toThrow();
  });

  it('throws ZodError when q is empty string', async () => {
    const db = makeDb([]);
    await expect(search(db, { q: '' })).rejects.toThrow();
  });

  it('throws ZodError when q exceeds 512 characters', async () => {
    const db = makeDb([]);
    await expect(search(db, { q: 'a'.repeat(513) })).rejects.toThrow();
  });

  it('throws ZodError when limit exceeds 100', async () => {
    const db = makeDb([]);
    await expect(search(db, { q: 'test', limit: 101 })).rejects.toThrow();
  });

  it('throws ZodError when limit is 0', async () => {
    const db = makeDb([]);
    await expect(search(db, { q: 'test', limit: 0 })).rejects.toThrow();
  });

  it('throws when the DB returns an error', async () => {
    const db = makeDb([], { message: 'FTS index not available' });
    await expect(search(db, { q: 'test' })).rejects.toThrow('FTS index not available');
  });

  it('maps each result row to the SearchEntry shape', async () => {
    const rows: FakeRow[] = [{ key: 'my-key', value: 'my-value', scope: 'repo::mthines/gw-tools', tags: ['a'] }];
    const db = makeDb(rows);
    const result = await search(db, { q: 'my' });
    const entry = result.entries[0]!;
    expect(entry).toMatchObject({
      key: 'my-key',
      value: 'my-value',
      scope: 'repo::mthines/gw-tools',
      tags: ['a'],
      rank: 1,
    });
  });
});
