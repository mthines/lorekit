/**
 * Tests for the `lib/lore.ts` server actions, which now speak to LoreKit's own
 * REST API rather than to PostgREST.
 *
 * `fetch` is stubbed, so no live API and no database is needed. What these
 * assert is the CONTRACT the dashboard relies on — the route, method and body
 * of each call — which is exactly what used to be asserted about the
 * `memory_write` RPC arguments, moved one layer out.
 *
 * The regression these tests carry forward: the previous version sent
 * `p_ttl_days` to an RPC that (since 00038) only accepts `p_ttl_seconds`, so
 * every TTL edit failed silently. The TTL now travels as `ttl_days` in a PATCH
 * body and `handleUpdate` owns the translation — so the assertion that pins it
 * belongs on the request body.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Prevent `revalidatePath` from throwing in the test environment.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

// The access token is the only thing the actions need from the session; the
// Supabase server client itself is never touched by them any more.
const mockToken = vi.fn<() => Promise<string | null>>();
vi.mock('@/lib/api/session-server', () => ({ serverAccessToken: () => mockToken() }));

const SUPABASE_URL = 'https://project.supabase.co';
const BASE = `${SUPABASE_URL}/functions/v1`;
process.env['NEXT_PUBLIC_SUPABASE_URL'] = SUPABASE_URL;

const { updateLesson, archiveLesson, restoreLesson, purgeArchivedLessons } = await import('./lore');
const { revalidatePath } = await import('next/cache');

// ── fetch harness ─────────────────────────────────────────────────────────────

interface StubbedCall { url: string; init: RequestInit }

const calls: StubbedCall[] = [];
let responder: (url: string, init: RequestInit) => Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One `MemoryEntry` as `GET /memories` returns it. */
const entry = {
  id: 'mem-abc',
  scope: 'project::myproject',
  key: 'my-key',
  value: 'v',
  tags: [],
  source_agent: 'agent0',
  trigger: 'hook',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  expires_at: null,
  archived_at: null,
};

function bodyOf(call: StubbedCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockToken.mockResolvedValue('jwt-token');
  responder = () => jsonResponse({});
  vi.stubGlobal('fetch', ((url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responder(String(url), init));
  }) as unknown as typeof fetch);
});

// ── updateLesson ──────────────────────────────────────────────────────────────

describe('updateLesson', () => {
  it('returns an error when there is no session', async () => {
    mockToken.mockResolvedValue(null);

    const result = await updateLesson('global', 'my-key', { value: 'v', tags: [] });

    expect(result.id).toBeNull();
    expect(result.error).toMatch(/not authenticated/i);
    expect(calls).toHaveLength(0);
  });

  it('returns an error when the memory is not found, without attempting a write', async () => {
    responder = () => jsonResponse({ entries: [], hasMore: false, nextCursor: null });

    const result = await updateLesson('global', 'missing-key', { value: 'v', tags: [] });

    expect(result.id).toBeNull();
    expect(result.error).toBe('Memory not found');
    expect(calls.every((c) => (c.init.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('resolves the row by natural key, then PATCHes it by id', async () => {
    responder = (url, init) =>
      (init.method === 'PATCH'
        ? jsonResponse({ ...entry, value: 'Updated value', tags: ['tag1', 'tag2'] })
        : jsonResponse({ entries: [entry], hasMore: false, nextCursor: null }));

    const result = await updateLesson('project::myproject', 'my-key', {
      value: 'Updated value',
      tags: ['tag1', 'tag2'],
    });

    expect(result).toEqual({ id: 'mem-abc' });

    const lookup = calls[0]!;
    expect(lookup.url).toContain(`${BASE}/memories?`);
    expect(lookup.url).toContain('scope=project%3A%3Amyproject');
    expect(lookup.url).toContain('key=my-key');

    const patch = calls[1]!;
    expect(patch.url).toBe(`${BASE}/memories/mem-abc`);
    expect(patch.init.method).toBe('PATCH');
    expect(bodyOf(patch)).toEqual({ value: 'Updated value', tags: ['tag1', 'tag2'] });

    expect(revalidatePath).toHaveBeenCalledWith('/lore');
  });

  it('never sends source_agent or trigger — a PATCH leaves untouched columns alone', async () => {
    responder = (_url, init) =>
      (init.method === 'PATCH'
        ? jsonResponse(entry)
        : jsonResponse({ entries: [entry], hasMore: false, nextCursor: null }));

    await updateLesson('global', 'k', { value: 'new-val', tags: [] });

    const patched = bodyOf(calls.at(-1));
    expect('source_agent' in patched).toBe(false);
    expect('trigger' in patched).toBe(false);
    expect('created_at' in patched).toBe(false);
  });

  it('sends the TTL as ttl_days, which the API translates into expires_at', async () => {
    responder = (_url, init) =>
      (init.method === 'PATCH'
        ? jsonResponse(entry)
        : jsonResponse({ entries: [entry], hasMore: false, nextCursor: null }));

    await updateLesson('global', 'k', { value: 'v', tags: [], ttl_days: 7 });

    expect(bodyOf(calls.at(-1))['ttl_days']).toBe(7);
  });

  it('sends clear_ttl only when it is set, so a plain edit never drops an expiry', async () => {
    responder = (_url, init) =>
      (init.method === 'PATCH'
        ? jsonResponse(entry)
        : jsonResponse({ entries: [entry], hasMore: false, nextCursor: null }));

    await updateLesson('global', 'k', { value: 'v', tags: [] });
    expect('clear_ttl' in bodyOf(calls.at(-1))).toBe(false);

    calls.length = 0;
    await updateLesson('global', 'k', { value: 'v', tags: [], clear_ttl: true });
    expect(bodyOf(calls.at(-1))['clear_ttl']).toBe(true);
  });

  it("forwards the API's error message and does not revalidate", async () => {
    responder = (_url, init) =>
      (init.method === 'PATCH'
        ? jsonResponse({ error: 'memory_cap: too many memories', code: 'memory_cap' }, 429)
        : jsonResponse({ entries: [entry], hasMore: false, nextCursor: null }));

    const result = await updateLesson('global', 'my-key', { value: 'v', tags: [] });

    expect(result.id).toBeNull();
    expect(result.error).toBe('memory_cap: too many memories');
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ── archive / restore / purge ─────────────────────────────────────────────────

describe('archiveLesson', () => {
  it('DELETEs by natural key WITHOUT force — the dashboard never hard-deletes', async () => {
    responder = () => new Response(null, { status: 204 });

    const result = await archiveLesson('global', 'k');

    expect(result).toEqual({ ok: true });
    const call = calls[0]!;
    expect(call.init.method).toBe('DELETE');
    expect(call.url).toContain(`${BASE}/memories?`);
    expect(call.url).toContain('scope=global');
    expect(call.url).toContain('key=k');
    expect(call.url).not.toContain('force');
  });

  it('reports a failure rather than throwing', async () => {
    responder = () => jsonResponse({ error: 'Memory not found', code: 'not_found' }, 404);

    expect(await archiveLesson('global', 'k')).toEqual({ ok: false, error: 'Memory not found' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('restoreLesson', () => {
  it('POSTs the natural key to /memories/restore', async () => {
    responder = () => jsonResponse({ restored: true });

    const result = await restoreLesson('global', 'k');

    expect(result).toEqual({ ok: true });
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/memories/restore`);
    expect(call.init.method).toBe('POST');
    expect(bodyOf(call)).toEqual({ scope: 'global', key: 'k' });
  });
});

describe('purgeArchivedLessons', () => {
  it('POSTs the retention window and returns the count', async () => {
    responder = () => jsonResponse({ purged: 3 });

    const result = await purgeArchivedLessons(14);

    expect(result).toEqual({ purged: 3 });
    expect(calls[0]!.url).toBe(`${BASE}/memories/purge`);
    expect(bodyOf(calls[0])).toEqual({ retention_days: 14 });
  });

  it('fails closed to zero purged', async () => {
    mockToken.mockResolvedValue(null);
    expect(await purgeArchivedLessons()).toEqual({ purged: 0, error: 'Not authenticated' });
  });
});
