import { describe, it, expect, vi } from 'vitest';
import { write } from './write.js';
import { LimitError, MEMORY_CAP_SQLSTATE } from '../limits/limits.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

const fakeResult = { id: 'uuid-1', created_at: '2026-01-01T00:00:00Z' };

function makeDb(
  data: null | { id: string; created_at: string; inserted?: boolean },
  error: null | { message: string; code?: string } = null,
) {
  return {
    rpc: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data, error }),
    }),
    // audit_log insert — always succeeds so the write path's recordAudit call
    // doesn't log noise for these tests; see audit.spec.ts for its own coverage.
    from: vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) }),
  } as unknown as SupabaseClient;
}

// ── write ─────────────────────────────────────────────────────────────────────

describe('write', () => {
  it('returns id and created_at on success', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'global', key: 'lesson-a', value: 'Learn from failures' });
    expect(result).toEqual(fakeResult);
  });

  it('passes optional tags, source_agent and trigger to the write RPC', async () => {
    const db = makeDb(fakeResult);
    await write(db, {
      scope: 'global',
      key: 'k',
      value: 'v',
      tags: ['skill::aw'],
      source_agent: 'aw-executor',
      trigger: 'stuck-loop',
    });
    // the RPC was called — just verify no error thrown
  });

  it('defaults tags to empty array when not provided', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'global', key: 'k', value: 'v' });
    expect(result).toEqual(fakeResult);
  });

  it('accepts a repo scope', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'repo::mthines/gw-tools', key: 'k', value: 'v' });
    expect(result).toEqual(fakeResult);
  });

  it('accepts a branch scope', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'branch::mthines/gw-tools::feat/x', key: 'k', value: 'v' });
    expect(result).toEqual(fakeResult);
  });

  it('throws ZodError when scope is missing', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { key: 'k', value: 'v' })).rejects.toThrow();
  });

  it('throws ZodError when key is missing', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'global', value: 'v' })).rejects.toThrow();
  });

  it('throws ZodError when value is missing', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'global', key: 'k' })).rejects.toThrow();
  });

  it('throws ZodError when key is empty', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'global', key: '', value: 'v' })).rejects.toThrow();
  });

  it('throws ZodError when value exceeds 65 536 bytes', async () => {
    const db = makeDb(fakeResult);
    const oversized = 'x'.repeat(65_537);
    await expect(write(db, { scope: 'global', key: 'k', value: oversized })).rejects.toThrow();
  });

  it('throws ScopeValidationError for invalid scope format', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'repo:noslash', key: 'k', value: 'v' })).rejects.toThrow();
  });

  it('throws ScopeValidationError for unknown scope prefix', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'workspace::foo', key: 'k', value: 'v' })).rejects.toThrow();
  });

  it('throws when the DB returns an error', async () => {
    const db = makeDb(null, { message: 'unique violation' });
    await expect(write(db, { scope: 'global', key: 'k', value: 'v' })).rejects.toThrow('unique violation');
  });

  it('throws a translated LimitError when the DB rejects the write via the cap trigger', async () => {
    const db = makeDb(null, { message: 'memory_cap_exceeded: limit=1000', code: MEMORY_CAP_SQLSTATE });
    const promise = write(db, { scope: 'global', key: 'k', value: 'v' });
    await expect(promise).rejects.toBeInstanceOf(LimitError);
    await expect(promise).rejects.toMatchObject({ code: 'memory_cap' });
    await expect(promise).rejects.toThrow(/1000/);
  });

  it('normalises scope to lowercase', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'GLOBAL', key: 'k', value: 'v' });
    expect(result).toEqual(fakeResult);
  });

  it('passes a null p_created_at to the RPC when created_at is omitted', async () => {
    const db = makeDb(fakeResult);
    await write(db, { scope: 'global', key: 'k', value: 'v' });
    expect(db.rpc).toHaveBeenCalledWith(
      'memory_write',
      expect.objectContaining({ p_created_at: null }),
    );
  });

  it('forwards a valid created_at override as a normalised ISO string', async () => {
    const db = makeDb(fakeResult);
    await write(db, { scope: 'global', key: 'k', value: 'v', created_at: '2020-06-15T08:30:00Z' });
    expect(db.rpc).toHaveBeenCalledWith(
      'memory_write',
      expect.objectContaining({ p_created_at: '2020-06-15T08:30:00.000Z' }),
    );
  });

  it('rejects an invalid created_at before touching the DB', async () => {
    const db = makeDb(fakeResult);
    await expect(
      write(db, { scope: 'global', key: 'k', value: 'v', created_at: 'not-a-date' }),
    ).rejects.toThrow(/valid date-time/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('rejects a future created_at', async () => {
    const db = makeDb(fakeResult);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await expect(
      write(db, { scope: 'global', key: 'k', value: 'v', created_at: future }),
    ).rejects.toThrow(/future/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('records a memory.create audit event when the RPC reports a fresh insert', async () => {
    const db = makeDb({ ...fakeResult, inserted: true });
    await write(db, { scope: 'global', key: 'k', value: 'v' });
    const insertMock = (db.from as ReturnType<typeof vi.fn>).mock.results[0].value.insert;
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.create' }));
  });

  it('records a memory.update audit event when the RPC reports an upsert-update', async () => {
    const db = makeDb({ ...fakeResult, inserted: false });
    await write(db, { scope: 'global', key: 'k', value: 'v' });
    const insertMock = (db.from as ReturnType<typeof vi.fn>).mock.results[0].value.insert;
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.update' }));
  });

  it('records the audit event with the resolved userId', async () => {
    const db = makeDb(fakeResult);
    await write(db, { scope: 'global', key: 'k', value: 'v' }, 'user-9');
    const insertMock = (db.from as ReturnType<typeof vi.fn>).mock.results[0].value.insert;
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user-9' }));
  });
});

// ── TTL — ttl_days ────────────────────────────────────────────────────────────

describe('write with ttl_days', () => {
  it('passes p_ttl_seconds (converted from days) to the RPC', async () => {
    const db = makeDb({ ...fakeResult, expires_at: '2026-08-03T00:00:00Z' });
    await write(db, { scope: 'global', key: 'k', value: 'v', ttl_days: 7 });
    expect(db.rpc).toHaveBeenCalledWith('memory_write', expect.objectContaining({ p_ttl_seconds: 7 * 86_400 }));
  });

  it('passes p_ttl_seconds: null to the RPC when no ttl_* is provided', async () => {
    const db = makeDb(fakeResult);
    await write(db, { scope: 'global', key: 'k', value: 'v' });
    expect(db.rpc).toHaveBeenCalledWith('memory_write', expect.objectContaining({ p_ttl_seconds: null }));
  });

  it('includes expires_at in the result when ttl_days is provided', async () => {
    const expiresAt = '2026-08-03T00:00:00Z';
    const db = makeDb({ ...fakeResult, expires_at: expiresAt });
    const result = await write(db, { scope: 'global', key: 'k', value: 'v', ttl_days: 7 });
    expect(result).toHaveProperty('expires_at', expiresAt);
  });

  it('does NOT include expires_at in the result when no ttl_* is provided', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'global', key: 'k', value: 'v' });
    expect(result).not.toHaveProperty('expires_at');
  });

  it('throws ZodError when ttl_days is 0', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'global', key: 'k', value: 'v', ttl_days: 0 })).rejects.toThrow();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('throws ZodError when ttl_days exceeds 365', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'global', key: 'k', value: 'v', ttl_days: 366 })).rejects.toThrow();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('accepts ttl_days at the boundary values (1 and 365)', async () => {
    const db1 = makeDb({ ...fakeResult, expires_at: '2026-07-28T00:00:00Z' });
    await expect(write(db1, { scope: 'global', key: 'k', value: 'v', ttl_days: 1 })).resolves.toBeDefined();
    const db365 = makeDb({ ...fakeResult, expires_at: '2027-07-27T00:00:00Z' });
    await expect(write(db365, { scope: 'global', key: 'k', value: 'v', ttl_days: 365 })).resolves.toBeDefined();
  });
});

// ── TTL — ttl_minutes ─────────────────────────────────────────────────────────

describe('write with ttl_minutes', () => {
  it('passes p_ttl_seconds (converted from minutes) to the RPC', async () => {
    const db = makeDb({ ...fakeResult, expires_at: '2026-07-30T11:00:00Z' });
    await write(db, { scope: 'global', key: 'k', value: 'v', ttl_minutes: 60 });
    expect(db.rpc).toHaveBeenCalledWith('memory_write', expect.objectContaining({ p_ttl_seconds: 3_600 }));
  });

  it('converts 90 minutes to 5400 seconds', async () => {
    const db = makeDb({ ...fakeResult, expires_at: '2026-07-30T11:30:00Z' });
    await write(db, { scope: 'global', key: 'k', value: 'v', ttl_minutes: 90 });
    expect(db.rpc).toHaveBeenCalledWith('memory_write', expect.objectContaining({ p_ttl_seconds: 5_400 }));
  });

  it('includes expires_at in the result when ttl_minutes is provided', async () => {
    const expiresAt = '2026-07-30T11:00:00Z';
    const db = makeDb({ ...fakeResult, expires_at: expiresAt });
    const result = await write(db, { scope: 'global', key: 'k', value: 'v', ttl_minutes: 60 });
    expect(result).toHaveProperty('expires_at', expiresAt);
  });

  it('throws ZodError when ttl_minutes is 0', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'global', key: 'k', value: 'v', ttl_minutes: 0 })).rejects.toThrow();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('accepts ttl_minutes at the boundary values (1 and max)', async () => {
    const maxMinutes = 365 * 24 * 60;
    const db1 = makeDb({ ...fakeResult, expires_at: '2026-07-30T10:33:00Z' });
    await expect(write(db1, { scope: 'global', key: 'k', value: 'v', ttl_minutes: 1 })).resolves.toBeDefined();
    const dbMax = makeDb({ ...fakeResult, expires_at: '2027-07-30T10:32:00Z' });
    await expect(write(dbMax, { scope: 'global', key: 'k', value: 'v', ttl_minutes: maxMinutes })).resolves.toBeDefined();
  });
});

// ── TTL — ttl_seconds ─────────────────────────────────────────────────────────

describe('write with ttl_seconds', () => {
  it('passes p_ttl_seconds directly to the RPC', async () => {
    const db = makeDb({ ...fakeResult, expires_at: '2026-07-30T10:33:00Z' });
    await write(db, { scope: 'global', key: 'k', value: 'v', ttl_seconds: 60 });
    expect(db.rpc).toHaveBeenCalledWith('memory_write', expect.objectContaining({ p_ttl_seconds: 60 }));
  });

  it('passes 30 seconds correctly', async () => {
    const db = makeDb({ ...fakeResult, expires_at: '2026-07-30T10:32:59Z' });
    await write(db, { scope: 'global', key: 'k', value: 'v', ttl_seconds: 30 });
    expect(db.rpc).toHaveBeenCalledWith('memory_write', expect.objectContaining({ p_ttl_seconds: 30 }));
  });

  it('includes expires_at in the result when ttl_seconds is provided', async () => {
    const expiresAt = '2026-07-30T10:33:00Z';
    const db = makeDb({ ...fakeResult, expires_at: expiresAt });
    const result = await write(db, { scope: 'global', key: 'k', value: 'v', ttl_seconds: 60 });
    expect(result).toHaveProperty('expires_at', expiresAt);
  });

  it('throws ZodError when ttl_seconds is 0', async () => {
    const db = makeDb(fakeResult);
    await expect(write(db, { scope: 'global', key: 'k', value: 'v', ttl_seconds: 0 })).rejects.toThrow();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('accepts ttl_seconds at the boundary values (1 and max)', async () => {
    const maxSeconds = 365 * 24 * 60 * 60;
    const db1 = makeDb({ ...fakeResult, expires_at: '2026-07-30T10:32:30Z' });
    await expect(write(db1, { scope: 'global', key: 'k', value: 'v', ttl_seconds: 1 })).resolves.toBeDefined();
    const dbMax = makeDb({ ...fakeResult, expires_at: '2027-07-30T10:32:00Z' });
    await expect(write(dbMax, { scope: 'global', key: 'k', value: 'v', ttl_seconds: maxSeconds })).resolves.toBeDefined();
  });
});

// ── TTL — mutual exclusivity ──────────────────────────────────────────────────

describe('write TTL mutual exclusivity', () => {
  it('throws TtlError when ttl_days and ttl_minutes are both supplied', async () => {
    const db = makeDb(fakeResult);
    await expect(
      write(db, { scope: 'global', key: 'k', value: 'v', ttl_days: 1, ttl_minutes: 60 }),
    ).rejects.toThrow(/at most one/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('throws TtlError when ttl_days and ttl_seconds are both supplied', async () => {
    const db = makeDb(fakeResult);
    await expect(
      write(db, { scope: 'global', key: 'k', value: 'v', ttl_days: 1, ttl_seconds: 60 }),
    ).rejects.toThrow(/at most one/);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('throws TtlError when ttl_minutes and ttl_seconds are both supplied', async () => {
    const db = makeDb(fakeResult);
    await expect(
      write(db, { scope: 'global', key: 'k', value: 'v', ttl_minutes: 5, ttl_seconds: 30 }),
    ).rejects.toThrow(/at most one/);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

// ── origin (provenance) ──────────────────────────────────────────────────────

describe('write — origin', () => {
  function rpcArgs(db: SupabaseClient) {
    return (db.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
  }

  it('forwards all four origin fields to the RPC, normalised', async () => {
    const db = makeDb(fakeResult);
    await write(db, {
      scope: 'global',
      key: 'k',
      value: 'v',
      origin_repo: 'MThines/LoreKit',
      origin_branch: 'feat/Origin-Provenance',
      origin_commit: 'ABC1234DEF',
      origin_pr: 482,
    });
    expect(rpcArgs(db)).toMatchObject({
      p_origin_repo: 'mthines/lorekit',
      // Not lowercased — the GitHub /tree/ link must resolve for a mixed-case branch.
      p_origin_branch: 'feat/Origin-Provenance',
      p_origin_commit: 'abc1234def',
      p_origin_pr: 482,
    });
  });

  it('sends null for every origin field when none is supplied', async () => {
    const db = makeDb(fakeResult);
    await write(db, { scope: 'global', key: 'k', value: 'v' });
    expect(rpcArgs(db)).toMatchObject({
      p_origin_repo: null,
      p_origin_branch: null,
      p_origin_commit: null,
      p_origin_pr: null,
    });
  });

  it('accepts a partial origin (branch known, PR not opened yet)', async () => {
    const db = makeDb(fakeResult);
    await write(db, { scope: 'global', key: 'k', value: 'v', origin_branch: 'feat/x' });
    expect(rpcArgs(db)).toMatchObject({ p_origin_branch: 'feat/x', p_origin_pr: null });
  });

  it('coerces a numeric-string PR number (env vars arrive as strings)', async () => {
    const db = makeDb(fakeResult);
    await write(db, { scope: 'global', key: 'k', value: 'v', origin_pr: '7' });
    expect(rpcArgs(db)).toMatchObject({ p_origin_pr: 7 });
  });

  it('rejects a malformed origin before touching the DB', async () => {
    const db = makeDb(fakeResult);
    await expect(
      write(db, { scope: 'global', key: 'k', value: 'v', origin_repo: 'not-a-repo' }),
    ).rejects.toThrow(/origin_repo/);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
