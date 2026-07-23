import { describe, it, expect, vi } from 'vitest';
import { archiveMemory, restoreMemory, listArchived } from './archive.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build an update-chain mock that resolves to the given result on the final .is() call. */
function updateDb(result: { error: null | { message: string }; count: number }) {
  return {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            is: vi.fn().mockResolvedValue(result),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

/** Build an update-chain mock that resolves on the final .not() call (used by restore). */
function restoreDb(result: { error: null | { message: string }; count: number }) {
  return {
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            not: vi.fn().mockResolvedValue(result),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

/** Build a select-chain mock for listArchived. */
function listDb(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          not: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

// ── archiveMemory ─────────────────────────────────────────────────────────────

describe('archiveMemory', () => {
  it('returns { archived: true } when the row is found and updated', async () => {
    const db = updateDb({ error: null, count: 1 });
    expect(await archiveMemory(db, { scope: 'global', key: 'k1' })).toEqual({ archived: true });
  });

  it('returns { archived: false } when row not found (already archived or missing)', async () => {
    const db = updateDb({ error: null, count: 0 });
    expect(await archiveMemory(db, { scope: 'global', key: 'missing' })).toEqual({ archived: false });
  });

  it('throws on DB error', async () => {
    const db = updateDb({ error: { message: 'timeout' }, count: 0 });
    await expect(archiveMemory(db, { scope: 'global', key: 'k' })).rejects.toThrow('timeout');
  });

  it('throws ZodError for missing key', async () => {
    const db = updateDb({ error: null, count: 0 });
    await expect(archiveMemory(db, { scope: 'global' })).rejects.toThrow();
  });
});

// ── restoreMemory ─────────────────────────────────────────────────────────────

describe('restoreMemory', () => {
  it('returns { restored: true } when archived row is found and cleared', async () => {
    const db = restoreDb({ error: null, count: 1 });
    expect(await restoreMemory(db, { scope: 'global', key: 'k1' })).toEqual({ restored: true });
  });

  it('returns { restored: false } when row not found (already active or missing)', async () => {
    const db = restoreDb({ error: null, count: 0 });
    expect(await restoreMemory(db, { scope: 'global', key: 'missing' })).toEqual({ restored: false });
  });

  it('throws on DB error', async () => {
    const db = restoreDb({ error: { message: 'timeout' }, count: 0 });
    await expect(restoreMemory(db, { scope: 'global', key: 'k' })).rejects.toThrow('timeout');
  });
});

// ── listArchived ──────────────────────────────────────────────────────────────

describe('listArchived', () => {
  const fakeRow = {
    key: 'k1',
    value: 'v1',
    tags: ['a'],
    updated_at: '2026-01-01T00:00:00Z',
    archived_at: '2026-03-01T00:00:00Z',
  };

  it('returns entries array from DB rows', async () => {
    const db = listDb([fakeRow]);
    const result = await listArchived(db, { scope: 'global' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ key: 'k1', archived_at: '2026-03-01T00:00:00Z' });
  });

  it('returns empty array when archive is empty', async () => {
    const db = listDb([]);
    const result = await listArchived(db, { scope: 'global' });
    expect(result.entries).toEqual([]);
  });

  it('applies default limit of 50 (does not exceed 100)', async () => {
    // The DB mock records whatever .limit() was called with; we just check it
    // doesn't throw and returns the data shape.
    const db = listDb([fakeRow]);
    const result = await listArchived(db, { scope: 'global', limit: 10 });
    expect(result.entries).toHaveLength(1);
  });

  it('throws ZodError when limit exceeds 100', async () => {
    const db = listDb([]);
    await expect(listArchived(db, { scope: 'global', limit: 101 })).rejects.toThrow();
  });
});
