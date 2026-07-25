import { describe, it, expect, vi } from 'vitest';
import { purgeArchived, PURGE_RETENTION_DAYS_DEFAULT } from './purge.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

function makeRpcDb(rpcResult: { data: unknown; error: null | { message: string } }) {
  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  const db = {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn().mockReturnValue({ insert: auditInsert }),
  } as unknown as SupabaseClient & { auditInsert: typeof auditInsert };
  db.auditInsert = auditInsert;
  return db;
}

describe('purgeArchived', () => {
  it('returns { purged: N } with the count returned by the RPC', async () => {
    const db = makeRpcDb({ data: 5, error: null });
    const result = await purgeArchived(db, {}, 'user-abc');
    expect(result).toEqual({ purged: 5 });
  });

  it('returns { purged: 0 } when no rows are eligible', async () => {
    const db = makeRpcDb({ data: 0, error: null });
    const result = await purgeArchived(db, {}, 'user-abc');
    expect(result).toEqual({ purged: 0 });
  });

  it('records a single memory.delete audit summary event when rows were purged', async () => {
    const db = makeRpcDb({ data: 5, error: null });
    await purgeArchived(db, { retention_days: 14 }, 'user-abc');
    expect(db.auditInsert).toHaveBeenCalledTimes(1);
    expect(db.auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'memory.delete',
        user_id: 'user-abc',
        metadata: { purged: 5, retention_days: 14 },
      }),
    );
  });

  it('does not record an audit event when no rows were purged', async () => {
    const db = makeRpcDb({ data: 0, error: null });
    await purgeArchived(db, {}, 'user-abc');
    expect(db.auditInsert).not.toHaveBeenCalled();
  });

  it('calls rpc with purge_archived_memories and correct params', async () => {
    const db = makeRpcDb({ data: 3, error: null });
    await purgeArchived(db, { retention_days: 7 }, 'user-abc');
    expect(db.rpc).toHaveBeenCalledWith('purge_archived_memories', {
      p_user_id: 'user-abc',
      p_retention_days: 7,
    });
  });

  it(`uses default retention of ${PURGE_RETENTION_DAYS_DEFAULT} days when not specified`, async () => {
    const db = makeRpcDb({ data: 0, error: null });
    await purgeArchived(db, {}, 'user-abc');
    expect(db.rpc).toHaveBeenCalledWith('purge_archived_memories', {
      p_user_id: 'user-abc',
      p_retention_days: PURGE_RETENTION_DAYS_DEFAULT,
    });
  });

  it('throws when userId is null — cannot safely scope the purge', async () => {
    const db = makeRpcDb({ data: 0, error: null });
    await expect(purgeArchived(db, {}, null)).rejects.toThrow('user_id');
  });

  it('throws on RPC error', async () => {
    const db = makeRpcDb({ data: null, error: { message: 'db error' } });
    await expect(purgeArchived(db, {}, 'user-abc')).rejects.toThrow('db error');
  });

  it('throws ZodError when retention_days exceeds 365', async () => {
    const db = makeRpcDb({ data: 0, error: null });
    await expect(purgeArchived(db, { retention_days: 366 }, 'user-abc')).rejects.toThrow();
  });

  it('throws ZodError when retention_days is 0', async () => {
    const db = makeRpcDb({ data: 0, error: null });
    await expect(purgeArchived(db, { retention_days: 0 }, 'user-abc')).rejects.toThrow();
  });
});
