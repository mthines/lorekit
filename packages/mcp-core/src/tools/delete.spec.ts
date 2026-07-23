import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deleteMemory } from './delete.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Stub out OTel — no SDK is initialised in unit tests.
vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({
        setAttribute: vi.fn(),
        setStatus: vi.fn(),
        end: vi.fn(),
      }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

/** Build a minimal Supabase client mock with chainable query methods. */
function makeDb(overrides: {
  updateResult?: { error: null | { message: string }; count: number };
  deleteResult?: { error: null | { message: string }; count: number };
}) {
  const updateChain = {
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    then: undefined as unknown,
  };
  // resolve on .is() — final call in the chain
  Object.defineProperty(updateChain, 'then', {
    get() { return undefined; },
  });

  const update = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        is: vi.fn().mockResolvedValue(overrides.updateResult ?? { error: null, count: 1 }),
      }),
    }),
  });

  const del = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue(overrides.deleteResult ?? { error: null, count: 1 }),
    }),
  });

  return {
    from: vi.fn().mockReturnValue({ update, delete: del }),
  } as unknown as SupabaseClient;
}

describe('deleteMemory — soft-archive (default)', () => {
  it('sets archived_at and returns { deleted: false, archived: true } when row is found', async () => {
    const db = makeDb({ updateResult: { error: null, count: 1 } });
    const result = await deleteMemory(db, { scope: 'global', key: 'my-key' });
    expect(result).toEqual({ deleted: false, archived: true });
  });

  it('returns { deleted: false, archived: false } when row is not found (already archived)', async () => {
    const db = makeDb({ updateResult: { error: null, count: 0 } });
    const result = await deleteMemory(db, { scope: 'global', key: 'missing-key' });
    expect(result).toEqual({ deleted: false, archived: false });
  });

  it('throws when the DB returns an error', async () => {
    const db = makeDb({ updateResult: { error: { message: 'connection refused' }, count: 0 } });
    await expect(deleteMemory(db, { scope: 'global', key: 'any' })).rejects.toThrow('connection refused');
  });
});

describe('deleteMemory — force hard-delete', () => {
  it('returns { deleted: true, archived: false } when row is deleted', async () => {
    const db = makeDb({ deleteResult: { error: null, count: 1 } });
    const result = await deleteMemory(db, { scope: 'global', key: 'my-key', force: true });
    expect(result).toEqual({ deleted: true, archived: false });
  });

  it('returns { deleted: false, archived: false } when row is not found', async () => {
    const db = makeDb({ deleteResult: { error: null, count: 0 } });
    const result = await deleteMemory(db, { scope: 'global', key: 'gone', force: true });
    expect(result).toEqual({ deleted: false, archived: false });
  });

  it('throws when the DB returns an error', async () => {
    const db = makeDb({ deleteResult: { error: { message: 'permission denied' }, count: 0 } });
    await expect(deleteMemory(db, { scope: 'global', key: 'any', force: true })).rejects.toThrow('permission denied');
  });
});

describe('deleteMemory — input validation', () => {
  const db = makeDb({});

  it('throws ZodError for missing scope', async () => {
    await expect(deleteMemory(db, { key: 'x' })).rejects.toThrow();
  });

  it('throws ZodError for missing key', async () => {
    await expect(deleteMemory(db, { scope: 'global' })).rejects.toThrow();
  });

  it('throws ScopeValidationError for invalid scope format', async () => {
    await expect(deleteMemory(db, { scope: 'repo:noslash', key: 'x' })).rejects.toThrow();
  });
});
