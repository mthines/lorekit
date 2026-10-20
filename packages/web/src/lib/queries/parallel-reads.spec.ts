/**
 * The three reads `/lore` fires on every load and every window-focus refetch —
 * the Explorer's list, the top bar's memory badge and the pending-invites query
 * — used to be Next.js server actions. The app router runs server actions one
 * at a time per client, and a server action cannot take an AbortSignal, so the
 * three queued (badge → invites → list) and kept the header's activity bar lit
 * long after every visible panel had loaded.
 *
 * Pinned here: each hook now issues an ordinary request that carries React
 * Query's signal, and none of them reaches for a server action. The server
 * action modules are mocked to THROW, so a hook that regressed to calling one
 * fails loudly instead of passing against a stub.
 *
 * No DOM environment in this package, so the hooks run as plain functions with
 * `useQuery` / `useInfiniteQuery` swapped for a recorder of their options —
 * the same harness `lore-scopes-dedupe.spec.ts` uses.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RecordedOptions {
  queryKey: readonly unknown[];
  queryFn: (context: { pageParam?: unknown; signal: AbortSignal }) => Promise<unknown>;
}

const harness = vi.hoisted(() => ({ recorded: [] as RecordedOptions[] }));

const api = vi.hoisted(() => ({ listMemoriesPostRequest: vi.fn(), quotaRequest: vi.fn() }));

const calledServerAction = vi.hoisted(() => () => {
  throw new Error('a read went through a server action');
});

vi.mock('@/lib/org-invites', () => ({ listPendingInvitesForMe: calledServerAction }));
vi.mock('@/lib/lore', () => ({
  archiveLesson: calledServerAction,
  restoreLesson: calledServerAction,
}));

vi.mock('@/lib/api/session-browser', () => ({
  browserAccessToken: async () => 'test-token',
}));

vi.mock('@/lib/api/memories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/memories')>()),
  listMemoriesPostRequest: api.listMemoriesPostRequest,
  quotaRequest: api.quotaRequest,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  const record = (options: RecordedOptions) => {
    harness.recorded.push(options);
    return { data: undefined };
  };
  return { ...actual, useQuery: record, useInfiniteQuery: record };
});

const { useMemories } = await import('./lore');
const { useMemoryTotal } = await import('./plan');
const { usePendingInvitesForMe, PENDING_INVITES_PATH } = await import('./pending-invites');

/** The options a hook hands React Query, captured by running it once. */
function optionsOf(hook: () => unknown): RecordedOptions {
  harness.recorded = [];
  hook();
  const [options] = harness.recorded;
  if (!options) throw new Error('the hook registered no query');
  return options;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMemories', () => {
  const listOptions = () =>
    optionsOf(() => useMemories({ scope: 'repo::mthines/lorekit', search: '', range: null }));

  it('reads POST /memories/list from the browser and hands it the query signal', async () => {
    api.listMemoriesPostRequest.mockResolvedValue({
      entries: [],
      hasMore: false,
      nextCursor: null,
      total: 0,
    });
    const { signal } = new AbortController();

    const page = await listOptions().queryFn({ pageParam: null, signal });

    expect(api.listMemoriesPostRequest).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({ scope: 'repo::mthines/lorekit', limit: 50, sort: 'created_at' }),
      signal,
    );
    expect(page).toEqual({ rows: [], hasMore: false, nextCursor: null, total: 0 });
  });

  it('sends the page cursor React Query passes for "Load more"', async () => {
    api.listMemoriesPostRequest.mockResolvedValue({ entries: [], hasMore: false, nextCursor: null });

    await listOptions().queryFn({ pageParam: 'cursor-2', signal: new AbortController().signal });

    expect(api.listMemoriesPostRequest.mock.calls[0]?.[1]).toMatchObject({ cursor: 'cursor-2' });
  });

  it('rejects on an API failure instead of passing it off as an empty list', async () => {
    api.listMemoriesPostRequest.mockRejectedValue(new Error('upstream 503'));

    await expect(
      listOptions().queryFn({ pageParam: null, signal: new AbortController().signal }),
    ).rejects.toThrow('upstream 503');
  });
});

describe('useMemoryTotal', () => {
  it('reads the total from GET /memories/quota with the query signal', async () => {
    api.quotaRequest.mockResolvedValue({
      plan: 'free',
      personal: { count: 3318, limit: 5000, remaining: 1682 },
      org_count: 982,
      total: 4300,
    });
    const { signal } = new AbortController();

    await expect(optionsOf(() => useMemoryTotal()).queryFn({ signal })).resolves.toBe(4300);
    expect(api.quotaRequest).toHaveBeenCalledWith('test-token', signal);
  });

  it('rejects on an API failure so React Query can retry it', async () => {
    api.quotaRequest.mockRejectedValue(new Error('upstream 503'));

    await expect(
      optionsOf(() => useMemoryTotal()).queryFn({ signal: new AbortController().signal }),
    ).rejects.toThrow('upstream 503');
  });
});

describe('usePendingInvitesForMe', () => {
  it('reads GET /api/invites/pending with the query signal', async () => {
    const invites = [{ id: 'inv-1', org_id: 'org-1', status: 'pending' }];
    fetchMock.mockResolvedValue(jsonResponse(invites));
    const { signal } = new AbortController();

    await expect(optionsOf(() => usePendingInvitesForMe()).queryFn({ signal })).resolves.toEqual(
      invites,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      PENDING_INVITES_PATH,
      expect.objectContaining({ method: 'GET', cache: 'no-store', signal }),
    );
  });
});

describe('the paths the hooks read', () => {
  it.each([PENDING_INVITES_PATH])('%s is served by a GET route handler', (path) => {
    const file = fileURLToPath(new URL(`../../app${path}/route.ts`, import.meta.url));

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/export async function GET\(/);
  });
});
