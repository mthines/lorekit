/**
 * The Lore Explorer mounts `useScopeTree` AND `useLoreData` together, and both
 * need the scope tree. Each used to call `GET /memories/scopes` on its own, so
 * every `/lore` load ran the `lorekit_memory_scopes` RPC twice, concurrently.
 * Pinned here: the two hooks share ONE request, and `useLoreData`'s `scopes`
 * is the very tree `useScopeTree` resolves to.
 *
 * There is no DOM test environment in this package, so the hooks run as plain
 * functions: `useQuery` is swapped for a recorder of the options each hook
 * hands it, and those options are then fetched through one real QueryClient —
 * the same cache, de-duplication and stale-time logic a mounted page gets.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, type UseQueryOptions } from '@tanstack/react-query';

const SCOPE_ROWS = [
  { scope: 'repo::mthines/lorekit', count: 3 },
  { scope: 'branch::mthines/lorekit::main', count: 2 },
  { scope: 'global', count: 1 },
];

const api = vi.hoisted(() => ({
  listScopesRequest: vi.fn(),
  listMemoriesRequest: vi.fn(),
  activityRequest: vi.fn(),
}));

const harness = vi.hoisted(() => ({
  client: undefined as unknown as QueryClient,
  recorded: [] as UseQueryOptions[],
}));

vi.mock('@/lib/api/session-browser', () => ({
  browserAccessToken: async () => 'test-token',
}));

vi.mock('@/lib/api/memories', () => ({
  ...api,
  getMemoryByIdRequest: vi.fn(),
  getMemoryByRefRequest: vi.fn(),
  listFacetsPostRequest: vi.fn(),
  listMemoriesPostRequest: vi.fn(),
  pivotPostRequest: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: (options: UseQueryOptions) => {
      harness.recorded.push(options);
      return { data: undefined };
    },
    useQueryClient: () => harness.client,
  };
});

const { useLoreData, useScopeTree } = await import('./lore');

/** Run a hook the way a mount would: capture its options, then fetch them. */
function mount(hook: () => unknown): Promise<unknown> {
  harness.recorded.length = 0;
  hook();
  const [options] = harness.recorded;
  return harness.client.fetchQuery(options as Parameters<QueryClient['fetchQuery']>[0]);
}

beforeEach(() => {
  harness.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.listScopesRequest.mockReset().mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve({ scopes: SCOPE_ROWS }), 10)),
  );
  api.listMemoriesRequest.mockReset().mockResolvedValue({ entries: [] });
  api.activityRequest.mockReset().mockResolvedValue({ buckets: [] });
});

describe('the /lore scope tree is fetched once', () => {
  it('shares one GET /memories/scopes between useScopeTree and useLoreData (page mount order)', async () => {
    const [tree, lore] = await Promise.all([mount(useScopeTree), mount(useLoreData)]);

    expect(api.listScopesRequest).toHaveBeenCalledTimes(1);
    expect((lore as { scopes: unknown }).scopes).toEqual(tree);
  });

  it('shares the request whichever hook mounts first', async () => {
    // Mounting both in one `Promise.all` does not reverse the order: the lore
    // fetch awaits the session token before it reaches the scopes query, so
    // `useScopeTree` would still start the request. Wait until the lore fetch
    // has actually issued it, then mount the scope tree into the in-flight
    // request (the mock answers after 10 ms; polling every 1 ms lands inside it).
    const lore = mount(useLoreData);
    await vi.waitFor(() => expect(api.listScopesRequest).toHaveBeenCalledTimes(1), { interval: 1 });
    const tree = await mount(useScopeTree);

    expect(api.listScopesRequest).toHaveBeenCalledTimes(1);
    expect(((await lore) as { scopes: unknown }).scopes).toEqual(tree);
  });

  it('hands a joining useScopeTree the shared retry policy when useLoreData starts the fetch', async () => {
    // The retry policy belongs to whichever caller STARTS the shared fetch, so
    // a no-retry override in the lore fetch would turn one transient scopes
    // failure into an error for the scope tree that joined it. Real ~1 s
    // backoff: TanStack's default retry delay, kept rather than faked.
    api.listScopesRequest.mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('transient')), 10)),
    );

    const lore = mount(useLoreData);
    await vi.waitFor(() => expect(api.listScopesRequest).toHaveBeenCalledTimes(1), { interval: 1 });
    const tree = (await mount(useScopeTree)) as { scope: string }[];

    expect(api.listScopesRequest).toHaveBeenCalledTimes(2);
    expect(tree.map((node) => node.scope)).toEqual(['repo::mthines/lorekit', 'global']);
    expect(((await lore) as { scopes: unknown }).scopes).toEqual(tree);
  });

  it('still fetches the scopes for useLoreData when no scope tree is cached', async () => {
    const lore = (await mount(useLoreData)) as { scopes: { scope: string }[] };

    expect(api.listScopesRequest).toHaveBeenCalledTimes(1);
    expect(lore.scopes.map((node) => node.scope)).toEqual(['repo::mthines/lorekit', 'global']);
  });
});
