/**
 * Typed wrappers over the `memories` REST function.
 *
 * Every request and response type is imported from `@lorekit/schemas` — the
 * package that also validates them on the server — so the dashboard cannot
 * invent a parameter the API does not accept or read a field it does not
 * return. When a handler's contract changes, this file stops compiling.
 *
 * Runtime-agnostic (see `rest.ts`): each function takes the caller's access
 * token, so the same wrappers serve browser hooks and server actions.
 */

import type {
  ActivityBody,
  ActivityQuery,
  ActivityResponse,
  FacetsResponse,
  ListFacetsBody,
  PivotBody,
  PivotResponse,
  ListFacetsQuery,
  ListMemoriesBody,
  ListMemoriesQuery,
  MemoryEntry,
  MemoryPageResponse,
  PurgeResponse,
  ReadActivityQuery,
  ReadActivityResponse,
  ReadRankingQuery,
  ReadRankingResponse,
  ScopesResponse,
  UpdateMemoryBody,
} from '@lorekit/schemas/memory';
import type { UsageStatsQuery, UsageStatsResponse, UsageRunsQuery, UsageRunsResponse } from '@lorekit/schemas/usage';
import { restFetch } from './rest';

/** The `GET /memories` query, minus the params the schema defaults for us. */
export type ListMemoriesParams = Partial<ListMemoriesQuery>;

export function listMemoriesRequest(
  accessToken: string,
  params: ListMemoriesParams,
  signal?: AbortSignal,
): Promise<MemoryPageResponse> {
  return restFetch<MemoryPageResponse>('/memories', {
    accessToken,
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

/**
 * `POST /memories/list` — the same read as {@link listMemoriesRequest}, with the
 * filters in a JSON body.
 *
 * The transport the dashboard uses, and the reason there are two: the query
 * form caps each dimension at 2048 characters, so a filter bar with enough
 * values is a 400 the Explorer can only render as "Failed to load memories",
 * and even under that cap a wide bar composes a URL past what the gateway
 * carries. Both routes run the same predicate function server-side, so this is
 * a transport choice and nothing else.
 */
export function listMemoriesPostRequest(
  accessToken: string,
  body: Partial<ListMemoriesBody>,
  signal?: AbortSignal,
): Promise<MemoryPageResponse> {
  return restFetch<MemoryPageResponse>('/memories/list', {
    accessToken,
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
  });
}

/**
 * A single memory by its natural key (scope + key), or null when none matches.
 *
 * There is no scope+key GET route — `GET /memories/:id` is UUID-only — but the
 * list route applies `key` as an exact match (`.eq`, not the substring `q`
 * filter), so `?scope=&key=&limit=1` is a precise one-row read: the same query
 * `updateLesson` uses to resolve a row. This wrapper hides the page envelope so
 * callers read it as the get-by-ref it is.
 */
export function getMemoryByRefRequest(
  accessToken: string,
  scope: string,
  key: string,
  signal?: AbortSignal,
): Promise<MemoryEntry | null> {
  return listMemoriesRequest(accessToken, { scope, key, limit: 1 }, signal).then(
    (page) => page.entries[0] ?? null,
  );
}

export function listScopesRequest(accessToken: string, signal?: AbortSignal): Promise<ScopesResponse> {
  return restFetch<ScopesResponse>('/memories/scopes', {
    accessToken,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `GET /memories/facets` — every filterable value, per dimension, with counts.
 *
 * One call for all eight dimensions rather than one per dimension: the filter
 * menu's cross-dimension type-ahead has to rank values it has not been told to
 * look for yet, and eight in-flight requests is eight chances to rank a
 * half-loaded catalog.
 *
 * `params` carries `archived` plus the caller's active DIMENSION filters (see
 * `filtersToFacetParams`). When filters are present the counts drill down
 * — each dimension is counted with every OTHER filter applied but not its own —
 * so a value's count is what selecting it would actually yield.
 *
 * The Explorer no longer calls this: it reads the catalog over
 * {@link listFacetsPostRequest} since the body transport landed, so the only
 * consumers left are specs. Kept because `GET /memories/facets` stays supported
 * for query-string callers outside this package.
 */
export function listFacetsRequest(
  accessToken: string,
  params: Partial<ListFacetsQuery>,
  signal?: AbortSignal,
): Promise<FacetsResponse> {
  return restFetch<FacetsResponse>('/memories/facets', {
    accessToken,
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

/**
 * `POST /memories/facets` — the drill-down catalog, over a body.
 *
 * The menu passes the whole active filter bar so its counts drill down, which
 * means it meets the query string's per-dimension cap at exactly the width the
 * list does. Switching the list alone would leave the Explorer rendering rows
 * with a 400 where the counts should be.
 */
export function listFacetsPostRequest(
  accessToken: string,
  body: Partial<ListFacetsBody>,
  signal?: AbortSignal,
): Promise<FacetsResponse> {
  return restFetch<FacetsResponse>('/memories/facets', {
    accessToken,
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `POST /memories/pivot` — two dimensions cross-tabulated, over a body.
 *
 * The body transport for `listFacetsPostRequest`' reason: the Explorer sends its
 * whole filter bar so the grid drills down with the list, which meets the query
 * string's per-dimension cap at exactly the width the list does.
 */
export function pivotPostRequest(
  accessToken: string,
  body: Partial<PivotBody> & Pick<PivotBody, 'row' | 'col'>,
  signal?: AbortSignal,
): Promise<PivotResponse> {
  return restFetch<PivotResponse>('/memories/pivot', {
    accessToken,
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
  });
}

export function activityRequest(
  accessToken: string,
  params: Partial<ActivityQuery>,
  signal?: AbortSignal,
): Promise<ActivityResponse> {
  return restFetch<ActivityResponse>('/memories/activity', {
    accessToken,
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

/**
 * `POST /memories/activity` — the written-volume series, over a body.
 *
 * The Explorer's stat header sends the same filter bar the list does, so it
 * shares the list's ceiling and needs the same transport.
 */
export function activityPostRequest(
  accessToken: string,
  body: Partial<ActivityBody>,
  signal?: AbortSignal,
): Promise<ActivityResponse> {
  return restFetch<ActivityResponse>('/memories/activity', {
    accessToken,
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `GET /memories/read-activity` — memory RECORDS read per UTC hour/day AND per
 * scope.
 *
 * The read counterpart to {@link activityRequest}; same window parameters, so
 * the Overview can chart written and read volume over one selected range.
 *
 * Cells are `(bucket, scope)` as of migration 00058 — one row per scope within
 * a bucket, mirroring the write series — and `scope` is NULLABLE here where the
 * write series' is not: a read may carry none the server could resolve, and
 * those rows are recorded unattributed rather than dropped. `params.scope`
 * restricts the result to one EXACT scope; it is validated server-side and a
 * malformed value is a 400, not an ignored filter. Because the unfiltered call
 * includes the NULL-scope remainder, a per-scope total can legitimately be
 * SMALLER than the account total — a UI showing both should say so.
 */
export function readActivityRequest(
  accessToken: string,
  params: Partial<ReadActivityQuery>,
  signal?: AbortSignal,
): Promise<ReadActivityResponse> {
  return restFetch<ReadActivityResponse>('/memories/read-activity', {
    accessToken,
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

/**
 * `GET /memories/read-ranking` — memories ranked by how often they have
 * actually been read (`read_count`, migration 00077). `direction: 'hot'`
 * (default) surfaces the most-consumed lore; `'cold'` the least — the
 * prune-list input the hot/cold lore panel and `lorekit-groom` skill consume.
 * REST-only: no MCP tool, no CLI command (`telemetry-vocabulary.ts`).
 */
export function readRankingRequest(
  accessToken: string,
  params: Partial<ReadRankingQuery>,
  signal?: AbortSignal,
): Promise<ReadRankingResponse> {
  return restFetch<ReadRankingResponse>('/memories/read-ranking', {
    accessToken,
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

/**
 * `GET /memories/:id` — a single memory addressed by DB row id.
 *
 * Unlike the scope+key list reads, this resolves one row directly, so a
 * deep-linked memory (`/lore?memoryId=…`) opens even when it is outside the
 * Explorer's recent/active window. Archived rows 404 — they are addressed by
 * scope+key and open from the archived list.
 */
export function getMemoryByIdRequest(
  accessToken: string,
  id: string,
  signal?: AbortSignal,
): Promise<MemoryEntry> {
  return restFetch<MemoryEntry>(`/memories/${encodeURIComponent(id)}`, {
    accessToken,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `PATCH /memories/:id` — a partial column update.
 *
 * Preferred over the `POST /memories` upsert for edits: it touches only the
 * fields named in the body, so `source_agent` / `trigger` / `created_at`
 * survive by construction rather than having to be read back and forwarded.
 */
export function updateMemoryRequest(
  accessToken: string,
  id: string,
  body: UpdateMemoryBody,
): Promise<MemoryEntry> {
  return restFetch<MemoryEntry>(`/memories/${encodeURIComponent(id)}`, {
    accessToken,
    method: 'PATCH',
    body,
  });
}

/**
 * `DELETE /memories?scope=…&key=…` — soft-archive (no `force`, so never a hard
 * delete from the dashboard's archive button).
 */
export function archiveMemoryRequest(
  accessToken: string,
  scope: string,
  key: string,
): Promise<void> {
  return restFetch<void>('/memories', {
    accessToken,
    method: 'DELETE',
    query: { scope, key },
  });
}

/** `POST /memories/restore` — the natural-key restore. */
export function restoreMemoryRequest(
  accessToken: string,
  scope: string,
  key: string,
): Promise<{ restored: boolean }> {
  return restFetch<{ restored: boolean }>('/memories/restore', {
    accessToken,
    method: 'POST',
    body: { scope, key },
  });
}

/** `POST /memories/purge` — hard-delete archived rows past the retention window. */
export function purgeMemoriesRequest(
  accessToken: string,
  retentionDays: number,
): Promise<PurgeResponse> {
  return restFetch<PurgeResponse>('/memories/purge', {
    accessToken,
    method: 'POST',
    body: { retention_days: retentionDays },
  });
}

/**
 * `GET /memories/usage` — aggregate usage statistics over a window.
 *
 * The Explorer's stats header reads exactly one figure from this:
 * `summary.expired`, the number of memory RECORDS a purge deleted because their
 * TTL had run out. That is the only place expiry is observable — a lazy read
 * filters expired rows but never deletes them, so there is no discrete expiry
 * moment on the read path; `purge_expired_memories` (migration 00045) records
 * one event per run carrying the count it removed, and this sums those.
 *
 * **It takes no `scope`.** `usage_events` is a per-user ledger with no scope
 * dimension on the expiry event (PR-1 deliberately deferred attributing one —
 * the purge is per-user and spans scopes), so this figure is ACCOUNT-WIDE for
 * the window even when the caller has a scope selected. Any UI showing it beside
 * scoped numbers has to say so.
 */
export function usageRequest(
  accessToken: string,
  params: Partial<UsageStatsQuery>,
  signal?: AbortSignal,
): Promise<UsageStatsResponse> {
  return restFetch<UsageStatsResponse>('/memories/usage', {
    accessToken,
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}

/**
 * `GET /memories/usage/runs` — enumerates runs (distinct `correlation_id`
 * values), the payoff view for `usageRequest`'s own `correlation_id` filter:
 * that answers "usage for THIS run"; this answers "which runs exist".
 * REST-only: no MCP tool, no CLI command.
 */
export function usageRunsRequest(
  accessToken: string,
  params: Partial<UsageRunsQuery>,
  signal?: AbortSignal,
): Promise<UsageRunsResponse> {
  return restFetch<UsageRunsResponse>('/memories/usage/runs', {
    accessToken,
    query: { ...params },
    ...(signal ? { signal } : {}),
  });
}
