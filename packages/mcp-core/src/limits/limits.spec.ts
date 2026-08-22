import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  translateCapError,
  checkRateLimit,
  memoryCapMessage,
  rateLimitMessage,
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

describe('dashboard URL in messages', () => {
  afterEach(() => {
    delete process.env['LOREKIT_APP_URL'];
  });

  it('defaults to the canonical lorekit.io origin', () => {
    delete process.env['LOREKIT_APP_URL'];
    expect(memoryCapMessage(1000)).toContain('https://lorekit.io');
    expect(rateLimitMessage(30)).toContain('https://lorekit.io');
  });

  it('honours a LOREKIT_APP_URL override at call time', () => {
    process.env['LOREKIT_APP_URL'] = 'https://staging.lorekit.io';
    expect(memoryCapMessage(1000)).toContain('https://staging.lorekit.io');
    expect(rateLimitMessage(30)).toContain('https://staging.lorekit.io');
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
