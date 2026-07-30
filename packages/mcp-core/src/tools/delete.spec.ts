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

/** Build a minimal Supabase client mock with chainable query methods.
 *
 * delete.ts uses .match(filter) for the equality predicates followed by
 * .is('archived_at', null) for the soft-archive path. The mock mirrors that:
 *   delete:  .delete({ count }).match(filter) → resolves
 *   update:  .update({ ... }, { count }).match(filter).is(...) → resolves
 */
function makeDb(overrides: {
  updateResult?: { error: null | { message: string }; count: number };
  deleteResult?: { error: null | { message: string }; count: number };
}) {
  const update = vi.fn().mockReturnValue({
    match: vi.fn().mockReturnValue({
      is: vi.fn().mockResolvedValue(overrides.updateResult ?? { error: null, count: 1 }),
    }),
  });

  const del = vi.fn().mockReturnValue({
    match: vi.fn().mockResolvedValue(overrides.deleteResult ?? { error: null, count: 1 }),
  });

  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  const db = {
    from: vi.fn().mockImplementation((table: string) =>
      table === 'audit_log' ? { insert: auditInsert } : { update, delete: del },
    ),
  } as unknown as SupabaseClient & { auditInsert: typeof auditInsert };
  db.auditInsert = auditInsert;
  return db;
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

  it('records a memory.archive audit event when a row is actually soft-archived', async () => {
    const db = makeDb({ updateResult: { error: null, count: 1 } });
    await deleteMemory(db, { scope: 'global', key: 'my-key' }, 'user-1');
    expect(db.auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'memory.archive', user_id: 'user-1' }),
    );
  });

  it('applies the user_id ownership filter when userId is provided', async () => {
    const db = makeDb({ updateResult: { error: null, count: 1 } });
    await deleteMemory(db, { scope: 'global', key: 'my-key' }, 'user-1');
    // The match filter must include user_id when a userId is known.
    const memTable = (db.from as ReturnType<typeof vi.fn>).mock.results.find(
      (r) => (r.value as { update: unknown }).update,
    )?.value as { update: ReturnType<typeof vi.fn> } | undefined;
    const matchArg = memTable?.update.mock.results[0]?.value?.match?.mock?.calls[0]?.[0];
    expect(matchArg).toMatchObject({ user_id: 'user-1', scope: 'global', key: 'my-key' });
  });

  it('does not include user_id in the filter when userId is null', async () => {
    const db = makeDb({ updateResult: { error: null, count: 1 } });
    await deleteMemory(db, { scope: 'global', key: 'my-key' });
    const memTable = (db.from as ReturnType<typeof vi.fn>).mock.results.find(
      (r) => (r.value as { update: unknown }).update,
    )?.value as { update: ReturnType<typeof vi.fn> } | undefined;
    const matchArg = memTable?.update.mock.results[0]?.value?.match?.mock?.calls[0]?.[0];
    expect(matchArg).not.toHaveProperty('user_id');
  });

  it('does not record an audit event when no row was soft-archived (no-op)', async () => {
    const db = makeDb({ updateResult: { error: null, count: 0 } });
    await deleteMemory(db, { scope: 'global', key: 'missing-key' });
    expect(db.auditInsert).not.toHaveBeenCalled();
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

  it('records a memory.delete audit event when a row is actually hard-deleted', async () => {
    const db = makeDb({ deleteResult: { error: null, count: 1 } });
    await deleteMemory(db, { scope: 'global', key: 'my-key', force: true }, 'user-1');
    expect(db.auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'memory.delete', user_id: 'user-1' }),
    );
  });

  it('applies the user_id ownership filter when userId is provided', async () => {
    const db = makeDb({ deleteResult: { error: null, count: 1 } });
    await deleteMemory(db, { scope: 'global', key: 'my-key', force: true }, 'user-1');
    const memTable = (db.from as ReturnType<typeof vi.fn>).mock.results.find(
      (r) => (r.value as { delete: unknown }).delete,
    )?.value as { delete: ReturnType<typeof vi.fn> } | undefined;
    const matchArg = memTable?.delete.mock.results[0]?.value?.match?.mock?.calls[0]?.[0];
    expect(matchArg).toMatchObject({ user_id: 'user-1', scope: 'global', key: 'my-key' });
  });

  it('does not include user_id in the filter when userId is null', async () => {
    const db = makeDb({ deleteResult: { error: null, count: 1 } });
    await deleteMemory(db, { scope: 'global', key: 'my-key', force: true });
    const memTable = (db.from as ReturnType<typeof vi.fn>).mock.results.find(
      (r) => (r.value as { delete: unknown }).delete,
    )?.value as { delete: ReturnType<typeof vi.fn> } | undefined;
    const matchArg = memTable?.delete.mock.results[0]?.value?.match?.mock?.calls[0]?.[0];
    expect(matchArg).not.toHaveProperty('user_id');
  });

  it('does not record an audit event when no row was hard-deleted (no-op)', async () => {
    const db = makeDb({ deleteResult: { error: null, count: 0 } });
    await deleteMemory(db, { scope: 'global', key: 'gone', force: true });
    expect(db.auditInsert).not.toHaveBeenCalled();
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
