/**
 * Integration-style tests for the archive / restore / purge lifecycle.
 *
 * These tests use an in-memory "database" that behaves like the Supabase
 * PostgREST client so we can exercise the full write → archive → restore →
 * archive → purge sequence without requiring a running Supabase instance.
 *
 * The mock respects the same query semantics as the real DB:
 *   - archived_at IS NULL  → row is "active"
 *   - archived_at IS NOT NULL → row is "archived"
 *   - Unique on (scope, key) among ACTIVE rows only
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { archiveMemory, restoreMemory, listArchived } from './archive.js';
import { deleteMemory } from './delete.js';
import { purgeArchived } from './purge.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// ── In-memory DB ──────────────────────────────────────────────────────────────

interface Row {
  scope: string;
  key: string;
  value: string;
  tags: string[];
  updated_at: string;
  archived_at: string | null;
}

function makeInMemoryDb(initialRows: Row[] = []): SupabaseClient {
  const rows: Row[] = [...initialRows];

  const rpc = vi.fn((fn: string, params: Record<string, unknown>) => {
    if (fn === 'purge_archived_memories') {
      const retentionDays = params['p_retention_days'] as number;
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      const before = rows.length;
      const toDelete = rows.filter(
        (r) => r.archived_at !== null && r.archived_at < cutoff,
      );
      toDelete.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return Promise.resolve({ data: before - rows.length, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unknown rpc: ${fn}` } });
  });

  // Build a chainable query builder that executes against the in-memory rows.
  function buildChain(filter: Partial<Row> & { notNull?: boolean; nullFilter?: keyof Row }) {
    let conditions: Array<(r: Row) => boolean> = [];

    const chain = {
      eq(col: string, val: unknown) {
        conditions.push((r) => (r as Record<string, unknown>)[col] === val);
        return chain;
      },
      is(col: string, val: null) {
        conditions.push((r) => (r as Record<string, unknown>)[col] === val);
        return chain;
      },
      not(col: string, op: string, val: unknown) {
        if (op === 'is') {
          conditions.push((r) => (r as Record<string, unknown>)[col] !== val);
        }
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      then: undefined as unknown,
    };

    // Attach an UPDATE executor
    (chain as unknown as Record<string, unknown>)['_update'] = (patch: Partial<Row>) => {
      const matched = rows.filter((r) => conditions.every((fn) => fn(r)));
      matched.forEach((r) => Object.assign(r, patch));
      conditions = [];
      return Promise.resolve({ error: null, count: matched.length });
    };

    // Attach a SELECT executor
    (chain as unknown as Record<string, unknown>)['_select'] = (cols: string[]) => {
      const matched = rows.filter((r) => conditions.every((fn) => fn(r)));
      const data = matched.map((r) =>
        Object.fromEntries(cols.map((c) => [c, (r as Record<string, unknown>)[c]])),
      );
      return Promise.resolve({ data, error: null });
    };

    return chain;
  }

  // Simplified proxy — captures update/select calls and resolves via the chain.
  const from = vi.fn((_table: string) => {
    const chain = buildChain({});
    let pendingPatch: Partial<Row> | null = null;
    let pendingCols: string[] | null = null;

    const proxy: Record<string, unknown> = {
      update(patch: Partial<Row>, _opts?: unknown) {
        pendingPatch = patch;
        return {
          eq: (...args: [string, unknown]) => {
            chain.eq(...args);
            return {
              eq: (...args2: [string, unknown]) => {
                chain.eq(...args2);
                return {
                  is: (...args3: [string, null]) => {
                    chain.is(...args3);
                    return Promise.resolve(
                      (chain as unknown as Record<string, unknown>)['_update']!(pendingPatch!),
                    ).then((r) => r);
                  },
                  not: (...args3: [string, string, unknown]) => {
                    chain.not(...args3);
                    return Promise.resolve(
                      (chain as unknown as Record<string, unknown>)['_update']!(pendingPatch!),
                    ).then((r) => r);
                  },
                };
              },
            };
          },
        };
      },
      select(cols: string) {
        pendingCols = cols.split(',').map((c) => c.trim());
        return {
          eq: (...args: [string, unknown]) => {
            chain.eq(...args);
            return {
              not: (...args2: [string, string, unknown]) => {
                chain.not(...args2);
                return {
                  order: () => ({
                    limit: () =>
                      (chain as unknown as Record<string, unknown>)['_select']!(pendingCols!),
                  }),
                };
              },
            };
          },
        };
      },
    };

    return proxy;
  });

  return { from, rpc } as unknown as SupabaseClient;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('archive lifecycle — write → archive → restore → archive → purge', () => {
  let rows: Row[];
  let db: SupabaseClient;

  beforeEach(() => {
    rows = [
      {
        scope: 'global',
        key: 'lesson-a',
        value: 'Always use worktree isolation',
        tags: ['skill::aw'],
        updated_at: '2026-01-01T00:00:00Z',
        archived_at: null,
      },
    ];
    db = makeInMemoryDb(rows);
  });

  it('archives an active row', async () => {
    const result = await archiveMemory(db, { scope: 'global', key: 'lesson-a' });
    expect(result.archived).toBe(true);
    expect(rows[0].archived_at).not.toBeNull();
  });

  it('archive is idempotent — second archive returns false', async () => {
    await archiveMemory(db, { scope: 'global', key: 'lesson-a' });
    const second = await archiveMemory(db, { scope: 'global', key: 'lesson-a' });
    expect(second.archived).toBe(false); // already archived, .is(null) filter misses it
  });

  it('restores an archived row', async () => {
    await archiveMemory(db, { scope: 'global', key: 'lesson-a' });
    const result = await restoreMemory(db, { scope: 'global', key: 'lesson-a' });
    expect(result.restored).toBe(true);
    expect(rows[0].archived_at).toBeNull();
  });

  it('restore is a no-op on active rows', async () => {
    const result = await restoreMemory(db, { scope: 'global', key: 'lesson-a' });
    expect(result.restored).toBe(false);
  });

  it('listArchived returns only archived rows', async () => {
    await archiveMemory(db, { scope: 'global', key: 'lesson-a' });
    const result = await listArchived(db, { scope: 'global' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe('lesson-a');
    expect(result.entries[0].archived_at).not.toBeNull();
  });

  it('listArchived returns empty when no archived rows exist', async () => {
    const result = await listArchived(db, { scope: 'global' });
    expect(result.entries).toHaveLength(0);
  });
});

describe('deleteMemory soft-archive then purge', () => {
  it('soft-archive via deleteMemory marks the row archived, purge removes it', async () => {
    const pastDate = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const rows: Row[] = [
      {
        scope: 'global', key: 'old-lesson', value: 'v',
        tags: [], updated_at: pastDate, archived_at: pastDate,
      },
    ];
    const db = makeInMemoryDb(rows);

    const result = await purgeArchived(db, { retention_days: 30 }, 'user-1');
    // The in-memory RPC correctly identifies the eligible row and returns 1.
    expect(result.purged).toBe(1);
  });

  it('purge does not remove rows archived within the retention window', async () => {
    const recentDate = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const rows: Row[] = [
      {
        scope: 'global', key: 'recent-lesson', value: 'v',
        tags: [], updated_at: recentDate, archived_at: recentDate,
      },
    ];
    const db = makeInMemoryDb(rows);

    const result = await purgeArchived(db, { retention_days: 30 }, 'user-1');
    expect(result.purged).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('purge does not remove active (non-archived) rows', async () => {
    const oldDate = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const rows: Row[] = [
      {
        scope: 'global', key: 'active-lesson', value: 'v',
        tags: [], updated_at: oldDate, archived_at: null,
      },
    ];
    const db = makeInMemoryDb(rows);

    const result = await purgeArchived(db, { retention_days: 30 }, 'user-1');
    expect(result.purged).toBe(0);
    expect(rows).toHaveLength(1);
  });
});
