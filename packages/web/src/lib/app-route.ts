/**
 * Browser GET of one of the dashboard's own Next route handlers (`app/api/**`),
 * read as JSON.
 *
 * This exists for the reads that still need server-side code: there is no REST
 * endpoint for them yet (`packages/web/CLAUDE.md` lists invites and plan usage
 * as migration backlog). They used to be called as server actions straight from
 * React Query, and Next's app router runs server actions one at a time per
 * client. Every read queued behind whichever action was already in flight, and
 * none of them could be aborted, so the header's activity bar stayed lit until
 * the whole chain had drained. A route handler is an ordinary request: it runs
 * alongside the others and takes React Query's AbortSignal.
 *
 * Same-origin, so the session cookie authenticates it; no token is passed.
 * `no-store` because these answer "what is true now": a refetch on window focus
 * must not be served from the HTTP cache.
 */

/** A non-2xx answer from an app route — the query's error, so React Query can retry it. */
export class AppRouteError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`GET ${path} failed with HTTP ${status}`);
    this.name = 'AppRouteError';
  }
}

export async function getAppRoute<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new AppRouteError(path, response.status);
  return (await response.json()) as T;
}
