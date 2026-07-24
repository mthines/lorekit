import { describe, it, expect, vi } from 'vitest';
import {
  rateLimitDecision,
  translateCapError,
  checkRateLimit,
  LimitError,
  MEMORY_CAP_SQLSTATE,
} from './limits.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('./telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

describe('rateLimitDecision', () => {
  it('allows when count is under the limit', () => {
    const result = rateLimitDecision(5, 120, 60);
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('allows when count equals the limit', () => {
    const result = rateLimitDecision(120, 120, 60);
    expect(result.allowed).toBe(true);
  });

  it('blocks with a positive retryAfterSeconds when over the limit', () => {
    const now = new Date('2026-01-01T00:00:30.000Z');
    const result = rateLimitDecision(121, 120, 60, now);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('retryAfterSeconds is bounded by the window size', () => {
    const now = new Date('2026-01-01T00:00:00.001Z');
    const result = rateLimitDecision(200, 120, 60, now);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('translateCapError', () => {
  it('translates a cap-SQLSTATE error into a LimitError(memory_cap) with an actionable message', () => {
    const dbError = { code: MEMORY_CAP_SQLSTATE, message: 'memory_cap_exceeded: limit=1000' };
    const result = translateCapError(dbError);
    expect(result).toBeInstanceOf(LimitError);
    const limitError = result as LimitError;
    expect(limitError.code).toBe('memory_cap');
    expect(limitError.message).toContain('1000');
    expect(limitError.message.toLowerCase()).toMatch(/raise|increase/);
  });

  it('falls back to the provided limit when the message has no parsable limit', () => {
    const dbError = { code: MEMORY_CAP_SQLSTATE, message: 'memory_cap_exceeded' };
    const result = translateCapError(dbError, 500) as LimitError;
    expect(result.message).toContain('500');
  });

  it('passes unrelated errors through unchanged', () => {
    const dbError = { code: '23505', message: 'duplicate key value violates unique constraint' };
    const result = translateCapError(dbError);
    expect(result).toBe(dbError);
  });

  it('passes through errors with no code at all', () => {
    const dbError = new Error('network timeout');
    const result = translateCapError(dbError);
    expect(result).toBe(dbError);
  });
});

describe('checkRateLimit', () => {
  function makeDb(rpcResult: { data: unknown; error: unknown }): SupabaseClient {
    return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient;
  }

  it('returns allowed=true when the RPC reports the request under the limit', async () => {
    const db = makeDb({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null });
    const result = await checkRateLimit(db, 'user-1');
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('returns allowed=false with retryAfterSeconds when the RPC reports over-limit', async () => {
    const db = makeDb({ data: [{ allowed: false, retry_after_seconds: 42 }], error: null });
    const result = await checkRateLimit(db, 'user-1');
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it('fails open (allowed=true) when the RPC errors', async () => {
    const db = makeDb({ data: null, error: { message: 'db unavailable' } });
    const result = await checkRateLimit(db, 'user-1');
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
});
