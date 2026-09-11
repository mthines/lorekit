import { describe, it, expect, vi } from 'vitest';
import { read } from './read.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

type Row = { scope: string; value: string; updated_at: string };

/**
 * The read now terminates in `.limit()` rather than `.maybeSingle()`: a scope
 * is optional, so the query can legitimately match one row per scope holding
 * the key, and the winner is picked in TypeScript by `scope-precedence`.
 * `rows` is therefore a LIST even in the single-hit cases below.
 */
function makeDb(rows: Row[] | null, error: null | { message: string } = null) {
  const chain = {
    eq: vi.fn(),
    is: vi.fn(),
    or: vi.fn(),
    order: vi.fn(),
    limit: vi.fn().mockResolvedValue({ data: rows, error }),
  };
  // Make every chained method return the chain itself for fluent chaining.
  chain.eq.mockReturnValue(chain);
  chain.is.mockReturnValue(chain);
  chain.or.mockReturnValue(chain);
  chain.order.mockReturnValue(chain);
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(chain),
    }),
  } as unknown as SupabaseClient;
}

// ── read ──────────────────────────────────────────────────────────────────────

describe('read', () => {
  it('returns the value, updated_at and the scope that answered', async () => {
    const row = { scope: 'global', value: 'Always use worktree isolation', updated_at: '2026-01-01T00:00:00Z' };
    const db = makeDb([row]);
    const result = await read(db, { scope: 'global', key: 'lesson-a' });
    // `scope` is on EVERY result, scoped read included — see ReadResult.
    expect(result).toEqual(row);
  });

  it('returns null when the key does not exist', async () => {
    const db = makeDb([]);
    const result = await read(db, { scope: 'global', key: 'missing-key' });
    expect(result).toBeNull();
  });

  it('works for a repo scope', async () => {
    const db = makeDb([{ scope: 'repo::mthines/gw-tools', value: 'v', updated_at: '2026-01-01T00:00:00Z' }]);
    const result = await read(db, { scope: 'repo::mthines/gw-tools', key: 'k' });
    expect(result).toMatchObject({ value: 'v' });
  });

  it('works for a branch scope', async () => {
    const db = makeDb([{ scope: 'branch::mthines/gw-tools::feat/x', value: 'v', updated_at: '2026-01-01T00:00:00Z' }]);
    const result = await read(db, { scope: 'branch::mthines/gw-tools::feat/x', key: 'k' });
    expect(result).toMatchObject({ value: 'v' });
  });

  it('throws ZodError when key is missing', async () => {
    const db = makeDb(null);
    await expect(read(db, { scope: 'global' })).rejects.toThrow();
  });

  it('throws ZodError when key is empty string', async () => {
    const db = makeDb(null);
    await expect(read(db, { scope: 'global', key: '' })).rejects.toThrow();
  });

  it('throws ScopeValidationError for single-colon separator', async () => {
    const db = makeDb(null);
    await expect(read(db, { scope: 'repo:noslash', key: 'k' })).rejects.toThrow();
  });

  it('throws when the DB returns an error', async () => {
    const db = makeDb(null, { message: 'permission denied' });
    await expect(read(db, { scope: 'global', key: 'k' })).rejects.toThrow('permission denied');
  });

  it('normalises scope to lowercase before querying', async () => {
    const db = makeDb([{ scope: 'repo::mthines/gw-tools', value: 'v', updated_at: '2026-01-01T00:00:00Z' }]);
    // Should not throw — scope normalisation happens inside the function
    const result = await read(db, { scope: 'REPO::Mthines/GW-Tools', key: 'k' });
    expect(result).toMatchObject({ value: 'v' });
  });
});

// ── negative retrieval: archived and expired rows are filtered out ────────────
// A behavioural absence assertion lives in supabase/tests/migrations.test.sql
// §60c (against real Postgres). This is the unit-level guard that the query the
// tool builds actually carries both filters, so a dropped filter fails here
// instead of silently surfacing hidden rows.

function makeCapturingDb() {
  const calls: { is: unknown[][]; or: unknown[][]; eq: unknown[][]; order: unknown[][] } = {
    is: [],
    or: [],
    eq: [],
    order: [],
  };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['eq'] = vi.fn((...args: unknown[]) => {
    calls.eq.push(args);
    return chain;
  });
  chain['is'] = vi.fn((...args: unknown[]) => {
    calls.is.push(args);
    return chain;
  });
  chain['or'] = vi.fn((...args: unknown[]) => {
    calls.or.push(args);
    return chain;
  });
  chain['order'] = vi.fn((...args: unknown[]) => {
    calls.order.push(args);
    return chain;
  });
  chain['limit'] = vi.fn().mockResolvedValue({
    data: [{ scope: 'global', value: 'v', updated_at: '2026-01-01T00:00:00Z' }],
    error: null,
  });
  const db = {
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('read excludes archived and expired rows', () => {
  it('applies the archived_at-is-null filter', async () => {
    const { db, calls } = makeCapturingDb();
    await read(db, { scope: 'global', key: 'k' });
    expect(calls.is).toContainEqual(['archived_at', null]);
  });

  it('applies the expires_at active-window filter', async () => {
    const { db, calls } = makeCapturingDb();
    await read(db, { scope: 'global', key: 'k' });
    expect(calls.or).toContainEqual(['expires_at.is.null,expires_at.gt.now()']);
  });
});

// ── unscoped read: `scope` is optional and resolves by precedence ─────────────
// The call this exists for is `read(db, { key })` with no scope — the commonest
// agent shape, since a key arrives from a SessionStart injection without the
// scope it came from. It used to be a hard ZodError.

describe('read without a scope', () => {
  const at = (iso: string) => `${iso}T00:00:00Z`;

  it('resolves a key that matches exactly one scope', async () => {
    const db = makeDb([{ scope: 'repo::o/r', value: 'v', updated_at: at('2026-01-01') }]);
    expect(await read(db, { key: 'k' })).toEqual({
      scope: 'repo::o/r',
      value: 'v',
      updated_at: at('2026-01-01'),
    });
  });

  it('prefers the more specific scope and names the ones it shadowed', async () => {
    const db = makeDb([
      { scope: 'global', value: 'broad', updated_at: at('2026-09-01') },
      { scope: 'repo::o/r', value: 'specific', updated_at: at('2026-01-01') },
    ]);
    // Recency does NOT beat specificity — the fresher `global` row loses to the
    // older repo one, which is the whole point of resolving by scope band first.
    expect(await read(db, { key: 'k' })).toEqual({
      scope: 'repo::o/r',
      value: 'specific',
      updated_at: at('2026-01-01'),
      other_scopes: ['global'],
    });
  });

  it('omits other_scopes entirely when the key was unambiguous', async () => {
    const db = makeDb([{ scope: 'global', value: 'v', updated_at: at('2026-01-01') }]);
    expect(await read(db, { key: 'k' })).not.toHaveProperty('other_scopes');
  });

  it('returns null when nothing matched', async () => {
    expect(await read(makeDb([]), { key: 'k' })).toBeNull();
  });

  it('still requires a key', async () => {
    await expect(read(makeDb([]), {})).rejects.toThrow();
  });

  it('does not filter on scope when none was given', async () => {
    const { db, calls } = makeCapturingDb();
    await read(db, { key: 'k' });
    expect(calls.eq).toEqual([['key', 'k']]);
  });

  it('filters on scope when one was given', async () => {
    const { db, calls } = makeCapturingDb();
    await read(db, { scope: 'global', key: 'k' });
    expect(calls.eq).toContainEqual(['scope', 'global']);
  });

  // The candidate fetch is capped, so WHICH rows come back decides the winner
  // before `pickScopeWinner`'s total order ever runs. Without an ORDER BY, a key
  // held in more scopes than the cap truncates to whatever order Postgres
  // returned and the same call can answer differently on consecutive runs — the
  // determinism `scope-precedence` exists to provide, lost one layer above it.
  it('orders the candidate fetch so the cap truncates deterministically', async () => {
    const { db, calls } = makeCapturingDb();
    await read(db, { key: 'k' });
    expect(calls.order).toEqual([['updated_at', { ascending: false }]]);
  });

  it('orders the candidate fetch on the scoped path too', async () => {
    const { db, calls } = makeCapturingDb();
    await read(db, { scope: 'global', key: 'k' });
    expect(calls.order).toEqual([['updated_at', { ascending: false }]]);
  });
});
