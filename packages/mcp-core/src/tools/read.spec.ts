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

function makeDb(data: null | { value: string; updated_at: string }, error: null | { message: string } = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const chain = {
    eq: vi.fn(),
    is: vi.fn(),
    or: vi.fn(),
    maybeSingle,
  };
  // Make every chained method return the chain itself for fluent chaining.
  chain.eq.mockReturnValue(chain);
  chain.is.mockReturnValue(chain);
  chain.or.mockReturnValue(chain);
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(chain),
    }),
  } as unknown as SupabaseClient;
}

// ── read ──────────────────────────────────────────────────────────────────────

describe('read', () => {
  it('returns the value and updated_at when the key exists', async () => {
    const row = { value: 'Always use worktree isolation', updated_at: '2026-01-01T00:00:00Z' };
    const db = makeDb(row);
    const result = await read(db, { scope: 'global', key: 'lesson-a' });
    expect(result).toEqual(row);
  });

  it('returns null when the key does not exist', async () => {
    const db = makeDb(null);
    const result = await read(db, { scope: 'global', key: 'missing-key' });
    expect(result).toBeNull();
  });

  it('works for a repo scope', async () => {
    const row = { value: 'v', updated_at: '2026-01-01T00:00:00Z' };
    const db = makeDb(row);
    const result = await read(db, { scope: 'repo::mthines/gw-tools', key: 'k' });
    expect(result).toMatchObject({ value: 'v' });
  });

  it('works for a branch scope', async () => {
    const row = { value: 'v', updated_at: '2026-01-01T00:00:00Z' };
    const db = makeDb(row);
    const result = await read(db, { scope: 'branch::mthines/gw-tools::feat/x', key: 'k' });
    expect(result).toMatchObject({ value: 'v' });
  });

  it('throws ZodError when scope is missing', async () => {
    const db = makeDb(null);
    await expect(read(db, { key: 'k' })).rejects.toThrow();
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
    const row = { value: 'v', updated_at: '2026-01-01T00:00:00Z' };
    const db = makeDb(row);
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
  const calls: { is: unknown[][]; or: unknown[][] } = { is: [], or: [] };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['eq'] = vi.fn(() => chain);
  chain['is'] = vi.fn((...args: unknown[]) => {
    calls.is.push(args);
    return chain;
  });
  chain['or'] = vi.fn((...args: unknown[]) => {
    calls.or.push(args);
    return chain;
  });
  chain['maybeSingle'] = vi.fn().mockResolvedValue({
    data: { value: 'v', updated_at: '2026-01-01T00:00:00Z' },
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
