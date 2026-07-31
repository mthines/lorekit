import { describe, it, expect, vi } from 'vitest';
import { list } from './list.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

const fakeEntry = {
  key: 'lesson-a',
  value: 'Always use worktree isolation',
  tags: ['skill::aw'],
  updated_at: '2026-01-01T00:00:00Z',
};

/**
 * Build a minimal Supabase client mock that resolves a select chain ending in
 * .order() with the supplied result.
 */
function makeDb(rows: unknown[], error: null | { message: string } = null) {
  // Fluent chain: every method returns the chain; order() resolves.
  const chain: Record<string, unknown> = {};
  const resolve = vi.fn().mockResolvedValue({ data: rows, error });
  const chainMethods = ['eq', 'is', 'or', 'limit', 'overlaps'];
  for (const m of chainMethods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['order'] = resolve;
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(chain),
    }),
  } as unknown as SupabaseClient;
}

// ── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('returns an entries array from DB rows', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ key: 'lesson-a', value: 'Always use worktree isolation' });
  });

  it('returns an empty entries array when no rows match', async () => {
    const db = makeDb([]);
    const result = await list(db, { scope: 'global' });
    expect(result.entries).toEqual([]);
  });

  it('returns entries for a project scope', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'project::agent-skills' });
    expect(result.entries).toHaveLength(1);
  });

  it('accepts all valid scope types', async () => {
    const scopes = [
      'global',
      'project::my-project',
      'repo::mthines/gw-tools',
      'branch::mthines/gw-tools::feat/x',
    ];
    for (const scope of scopes) {
      const db = makeDb([]);
      await expect(list(db, { scope })).resolves.toMatchObject({ entries: [] });
    }
  });

  it('applies a custom limit', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global', limit: 10 });
    expect(result.entries).toHaveLength(1);
  });

  it('throws ZodError when limit exceeds 100', async () => {
    const db = makeDb([]);
    await expect(list(db, { scope: 'global', limit: 101 })).rejects.toThrow();
  });

  it('throws ZodError when limit is less than 1', async () => {
    const db = makeDb([]);
    await expect(list(db, { scope: 'global', limit: 0 })).rejects.toThrow();
  });

  it('throws ZodError for missing scope', async () => {
    const db = makeDb([]);
    await expect(list(db, {})).rejects.toThrow();
  });

  it('throws ScopeValidationError for invalid scope format', async () => {
    const db = makeDb([]);
    await expect(list(db, { scope: 'repo:noslash' })).rejects.toThrow();
  });

  it('throws when the DB returns an error', async () => {
    const db = makeDb([], { message: 'connection refused' });
    await expect(list(db, { scope: 'global' })).rejects.toThrow('connection refused');
  });
});

// ── negative retrieval: archived and expired rows are filtered out ────────────
// Behavioural absence is asserted in supabase/tests/migrations.test.sql §60c;
// this guards that the query the tool builds carries both filters.

function makeCapturingDb() {
  const calls: { is: unknown[][]; or: unknown[][] } = { is: [], or: [] };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ['eq', 'limit', 'overlaps']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['is'] = vi.fn((...args: unknown[]) => {
    calls.is.push(args);
    return chain;
  });
  chain['or'] = vi.fn((...args: unknown[]) => {
    calls.or.push(args);
    return chain;
  });
  chain['order'] = vi.fn().mockResolvedValue({ data: [], error: null });
  const db = {
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('list excludes archived and expired rows', () => {
  it('applies the archived_at-is-null filter', async () => {
    const { db, calls } = makeCapturingDb();
    await list(db, { scope: 'global' });
    expect(calls.is).toContainEqual(['archived_at', null]);
  });

  it('applies the expires_at active-window filter', async () => {
    const { db, calls } = makeCapturingDb();
    await list(db, { scope: 'global' });
    expect(calls.or).toContainEqual(['expires_at.is.null,expires_at.gt.now()']);
  });
});
