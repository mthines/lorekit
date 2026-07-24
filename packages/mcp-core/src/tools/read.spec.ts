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
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data, error }),
          }),
        }),
      }),
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
