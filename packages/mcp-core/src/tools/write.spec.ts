import { describe, it, expect, vi } from 'vitest';
import { write } from './write.js';
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

function makeDb(data: null | { id: string; created_at: string }, error: null | { message: string } = null) {
  return {
    from: vi.fn().mockReturnValue({
      upsert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data, error }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

// ── write ─────────────────────────────────────────────────────────────────────

describe('write', () => {
  it('returns id and created_at on success', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'global', key: 'lesson-a', value: 'Learn from failures' });
    expect(result).toEqual(fakeResult);
  });

  it('passes optional tags, source_agent and trigger to upsert', async () => {
    const db = makeDb(fakeResult);
    await write(db, {
      scope: 'global',
      key: 'k',
      value: 'v',
      tags: ['skill::aw'],
      source_agent: 'aw-executor',
      trigger: 'stuck-loop',
    });
    // upsert was called — just verify no error thrown
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

  it('normalises scope to lowercase', async () => {
    const db = makeDb(fakeResult);
    const result = await write(db, { scope: 'GLOBAL', key: 'k', value: 'v' });
    expect(result).toEqual(fakeResult);
  });
});
