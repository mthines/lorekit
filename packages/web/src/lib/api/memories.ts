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
  ActivityQuery,
  ActivityResponse,
  FacetsResponse,
  ListMemoriesQuery,
  MemoryEntry,
  MemoryPageResponse,
  PurgeResponse,
  ReadActivityQuery,
  ReadActivityResponse,
  ScopesResponse,
  UpdateMemoryBody,
} from '@lorekit/schemas/memory';
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

export function listScopesRequest(accessToken: string, signal?: AbortSignal): Promise<ScopesResponse> {
  return restFetch<ScopesResponse>('/memories/scopes', {
    accessToken,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `GET /memories/facets` — every filterable value, per dimension, with counts.
 *
 * One call for all six dimensions rather than one per dimension: the filter
 * menu's cross-dimension type-ahead has to rank values it has not been told to
 * look for yet, and six in-flight requests is six chances to rank a half-loaded
 * catalog.
 */
export function listFacetsRequest(
  accessToken: string,
  archived: boolean,
  signal?: AbortSignal,
): Promise<FacetsResponse> {
  return restFetch<FacetsResponse>('/memories/facets', {
    accessToken,
    query: { archived: archived ? 'true' : 'false' },
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
 * `GET /memories/read-activity` — memory RECORDS read per UTC hour/day.
 *
 * The read counterpart to {@link activityRequest}; same window parameters, so
 * the Overview can chart written and read volume over one selected range.
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
