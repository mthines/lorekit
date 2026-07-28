import { describe, it, expect, vi } from 'vitest';
import { purgeExpired } from './purge-expired.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// Minimal in-memory DB stub that properly responds to RPC calls
function makeRpcDb(purgedCount: number, error: null | { message: string } = null) {
  const auditInsert = vi.fn().mockResolvedValue({ error: null });
  return {
    rpc: vi.fn().mockResolvedValue({ data: purgedCount, error }),
    from: vi.fn().mockReturnValue({ insert: auditInsert }),
  } as unknown as SupabaseClient;
}

describe('purgeExpired', () => {
  it('returns purged count when expired memories are deleted', async () => {
    const db = makeRpcDb(3);
    const result = await purgeExpired(db, 'user-abc');
    expect(result).toEqual({ purged: 3 });
  });

  it('calls purge_expired_memories RPC with p_user_id', async () => {
    const db = makeRpcDb(0);
    await purgeExpired(db, 'user-abc');
    expect(db.rpc).toHaveBeenCalledWith('purge_expired_memories', { p_user_id: 'user-abc' });
  });

  it('returns { purged: 0 } when no expired rows exist', async () => {
    const db = makeRpcDb(0);
    const result = await purgeExpired(db, 'user-abc');
    expect(result).toEqual({ purged: 0 });
  });

  it('writes an audit record when rows are purged', async () => {
    const auditInsert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      rpc: vi.fn().mockResolvedValue({ data: 5, error: null }),
      from: vi.fn().mockReturnValue({ insert: auditInsert }),
    } as unknown as SupabaseClient;
    await purgeExpired(db, 'user-abc');
    expect(db.from).toHaveBeenCalledWith('audit_log');
  });

  it('does NOT write an audit record when purged count is 0', async () => {
    const auditInsert = vi.fn().mockResolvedValue({ error: null });
    const db = {
      rpc: vi.fn().mockResolvedValue({ data: 0, error: null }),
      from: vi.fn().mockReturnValue({ insert: auditInsert }),
    } as unknown as SupabaseClient;
    await purgeExpired(db, 'user-abc');
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('throws when userId is null', async () => {
    const db = makeRpcDb(0);
    await expect(purgeExpired(db, null)).rejects.toThrow('user_id');
  });

  it('throws when the RPC returns an error', async () => {
    const db = makeRpcDb(0, { message: 'permission denied' });
    await expect(purgeExpired(db, 'user-abc')).rejects.toThrow('permission denied');
  });
});
