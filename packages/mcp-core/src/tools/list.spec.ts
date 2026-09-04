import { describe, it, expect, vi } from 'vitest';
import { list, LIST_PREVIEW_CHARS } from './list.js';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('../telemetry.js', () => ({
  getTracer: () => ({
    startActiveSpan: (_name: string, _opts: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }),
  }),
  getToolDurationHistogram: () => ({ record: vi.fn() }),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

const fakeEntry = {
  key: 'lesson-a',
  value: 'Always use worktree isolation',
  tags: ['skill::aw'],
  updated_at: '2026-01-01T00:00:00Z',
};

/**
 * Build a minimal Supabase client mock that resolves a select chain ending in
 * .order() with the supplied result.
 */
function makeDb(rows: unknown[], error: null | { message: string } = null) {
  // Fluent chain: every method returns the chain; order() resolves.
  const chain: Record<string, unknown> = {};
  const resolve = vi.fn().mockResolvedValue({ data: rows, error });
  const chainMethods = ['eq', 'is', 'or', 'limit', 'overlaps'];
  for (const m of chainMethods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['order'] = resolve;
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue(chain),
    }),
  } as unknown as SupabaseClient;
}

// ── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('returns an entries array from DB rows', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ key: 'lesson-a', value: 'Always use worktree isolation' });
  });

  it('returns an empty entries array when no rows match', async () => {
    const db = makeDb([]);
    const result = await list(db, { scope: 'global' });
    expect(result.entries).toEqual([]);
  });

  it('returns entries for a project scope', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'project::agent-skills' });
    expect(result.entries).toHaveLength(1);
  });

  it('accepts all valid scope types', async () => {
    const scopes = [
      'global',
      'project::my-project',
      'repo::mthines/gw-tools',
      'branch::mthines/gw-tools::feat/x',
    ];
    for (const scope of scopes) {
      const db = makeDb([]);
      await expect(list(db, { scope })).resolves.toMatchObject({ entries: [] });
    }
  });

  it('applies a custom limit', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global', limit: 10 });
    expect(result.entries).toHaveLength(1);
  });

  it('throws ZodError when limit exceeds 250', async () => {
    const db = makeDb([]);
    await expect(list(db, { scope: 'global', limit: 251 })).rejects.toThrow();
  });

  it('throws ZodError when limit is less than 1', async () => {
    const db = makeDb([]);
    await expect(list(db, { scope: 'global', limit: 0 })).rejects.toThrow();
  });

  it('throws ZodError for missing scope', async () => {
    const db = makeDb([]);
    await expect(list(db, {})).rejects.toThrow();
  });

  it('throws ScopeValidationError for invalid scope format', async () => {
    const db = makeDb([]);
    await expect(list(db, { scope: 'repo:noslash' })).rejects.toThrow();
  });

  it('throws when the DB returns an error', async () => {
    const db = makeDb([], { message: 'connection refused' });
    await expect(list(db, { scope: 'global' })).rejects.toThrow('connection refused');
  });
});

// ── negative retrieval: archived and expired rows are filtered out ────────────
// Behavioural absence is asserted in supabase/tests/migrations.test.sql §60c;
// this guards that the query the tool builds carries both filters.

function makeCapturingDb() {
  const calls: { is: unknown[][]; or: unknown[][] } = { is: [], or: [] };
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ['eq', 'limit', 'overlaps']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['is'] = vi.fn((...args: unknown[]) => {
    calls.is.push(args);
    return chain;
  });
  chain['or'] = vi.fn((...args: unknown[]) => {
    calls.or.push(args);
    return chain;
  });
  chain['order'] = vi.fn().mockResolvedValue({ data: [], error: null });
  const db = {
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe('list excludes archived and expired rows', () => {
  it('applies the archived_at-is-null filter', async () => {
    const { db, calls } = makeCapturingDb();
    await list(db, { scope: 'global' });
    expect(calls.is).toContainEqual(['archived_at', null]);
  });

  it('applies the expires_at active-window filter', async () => {
    const { db, calls } = makeCapturingDb();
    await list(db, { scope: 'global' });
    expect(calls.or).toContainEqual(['expires_at.is.null,expires_at.gt.now()']);
  });
});

// ── taxonomy filters: kind / host ────────────────────────────────────────────
// The `kind`/`host` columns exist since migration 00056 and the REST route has
// always been able to filter on them. Until now the MCP tool could not, so an
// MCP client had to over-fetch a whole scope and discard the wrong buckets
// client-side — the gap agent-skills' `memory-buckets.md` documents.

function makeEqCapturingDb() {
  const eqCalls: unknown[][] = [];
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ['is', 'or', 'limit', 'overlaps']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['eq'] = vi.fn((...args: unknown[]) => {
    eqCalls.push(args);
    return chain;
  });
  chain['order'] = vi.fn().mockResolvedValue({ data: [], error: null });
  const db = {
    from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue(chain) }),
  } as unknown as SupabaseClient;
  return { db, eqCalls };
}

describe('list taxonomy filters', () => {
  it('applies a kind filter when supplied', async () => {
    const { db, eqCalls } = makeEqCapturingDb();
    await list(db, { scope: 'global', kind: 'lesson' });
    expect(eqCalls).toContainEqual(['kind', 'lesson']);
  });

  it('applies a host filter when supplied', async () => {
    const { db, eqCalls } = makeEqCapturingDb();
    await list(db, { scope: 'global', host: 'reviewer' });
    expect(eqCalls).toContainEqual(['host', 'reviewer']);
  });

  it('combines kind and host into the one-bucket read', async () => {
    const { db, eqCalls } = makeEqCapturingDb();
    await list(db, { scope: 'global', kind: 'signal', host: 'reviewer' });
    expect(eqCalls).toContainEqual(['kind', 'signal']);
    expect(eqCalls).toContainEqual(['host', 'reviewer']);
  });

  it('applies neither filter when both are omitted — the historical read', async () => {
    const { db, eqCalls } = makeEqCapturingDb();
    await list(db, { scope: 'global' });
    expect(eqCalls.map(([col]) => col)).not.toContain('kind');
    expect(eqCalls.map(([col]) => col)).not.toContain('host');
  });

  it('rejects a kind outside the closed vocabulary', async () => {
    const { db } = makeEqCapturingDb();
    await expect(list(db, { scope: 'global', kind: 'lessons' })).rejects.toThrow();
  });

  it('rejects an empty host rather than filtering on the empty string', async () => {
    const { db } = makeEqCapturingDb();
    await expect(list(db, { scope: 'global', host: '' })).rejects.toThrow();
  });
});

// ── view: summary ────────────────────────────────────────────────────────────
// The discovery half of a read. A 50-entry `full` list at the observed ~1.9 KB
// median body is ~95 KB of caller context; `summary` makes the same read an
// index the caller resolves with targeted `memory.read` calls.

describe('list view projection', () => {
  it('returns the full value by default — the historical shape is unchanged', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global' });
    expect(result.entries[0]).toEqual(fakeEntry);
  });

  it('omits value entirely in summary mode', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    expect(result.entries[0]).not.toHaveProperty('value');
  });

  it('keeps the identifying fields in summary mode', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    expect(result.entries[0]).toMatchObject({
      key: 'lesson-a',
      tags: ['skill::aw'],
      updated_at: '2026-01-01T00:00:00Z',
    });
  });

  it('reports value_bytes as the BYTE length, not the character count', async () => {
    // "é" is two bytes in UTF-8 — String.length would report 1 and under-count.
    const db = makeDb([{ ...fakeEntry, value: 'é' }]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    expect(result.entries[0]).toMatchObject({ value_bytes: 2 });
  });

  it('truncates preview to LIST_PREVIEW_CHARS', async () => {
    const long = 'x'.repeat(500);
    const db = makeDb([{ ...fakeEntry, value: long }]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    const entry = result.entries[0] as { preview: string; value_bytes: number };
    expect(entry.preview).toHaveLength(LIST_PREVIEW_CHARS);
    // The full size is still reported, so the caller knows what it did not get.
    expect(entry.value_bytes).toBe(500);
  });

  it('leaves a body shorter than the cap intact', async () => {
    const db = makeDb([fakeEntry]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    expect(result.entries[0]).toMatchObject({ preview: 'Always use worktree isolation' });
  });

  it('rejects a view outside the closed vocabulary', async () => {
    const db = makeDb([fakeEntry]);
    await expect(list(db, { scope: 'global', view: 'brief' })).rejects.toThrow();
  });
});

// ── preview slicing is code-point-safe ───────────────────────────────────────
// String indices are UTF-16 code units. A naive `.slice(0, 200)` can cut
// between a surrogate pair and emit a lone half, which is not valid UTF-8 and
// round-trips through JSON as U+FFFD.

describe('list summary preview never splits a surrogate pair', () => {
  it('does not emit a lone surrogate when the cut lands mid-pair', async () => {
    // Each 😀 is two UTF-16 code units, so a 200-unit cut of 150 emoji lands
    // exactly on a pair boundary under the naive slice; offset it by one BMP
    // char so the naive cut would split the 100th emoji.
    const value = 'x' + '😀'.repeat(150);
    const db = makeDb([{ ...fakeEntry, value }]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    const { preview } = result.entries[0] as { preview: string };
    for (const unit of preview) {
      const code = unit.codePointAt(0) as number;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it('counts the cap in code points, so the preview is 200 characters', async () => {
    const db = makeDb([{ ...fakeEntry, value: '😀'.repeat(400) }]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    const { preview } = result.entries[0] as { preview: string };
    expect([...preview]).toHaveLength(LIST_PREVIEW_CHARS);
  });

  it('still reports value_bytes over the whole body, not the preview', async () => {
    const db = makeDb([{ ...fakeEntry, value: '😀'.repeat(400) }]);
    const result = await list(db, { scope: 'global', view: 'summary' });
    // 4 UTF-8 bytes per emoji.
    expect(result.entries[0]).toMatchObject({ value_bytes: 1600 });
  });
});
