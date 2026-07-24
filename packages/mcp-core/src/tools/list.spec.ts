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
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            order: vi.fn().mockResolvedValue({ data: rows, error }),
            overlaps: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: rows, error }),
            }),
          }),
          overlaps: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: rows, error }),
            }),
          }),
        }),
      }),
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
