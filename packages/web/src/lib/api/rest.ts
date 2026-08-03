/**
 * The dashboard's client for LoreKit's own REST API (the `memories` / `orgs`
 * Supabase Edge Functions).
 *
 * WHY this exists: the dashboard used to reach past its own API and query
 * PostgREST directly through supabase-js — the same tables, but with a second,
 * hand-written copy of every predicate the REST handlers already own
 * (tenant scoping, the active-vs-archived partition, the expiry filter, the
 * keyset cursor). Two implementations of one contract drift, and they had:
 * the row-cap bug that `GET /memories/scopes` was created to fix was still
 * live in the dashboard's scope tree, its label catalog and its dashboard
 * charts long after the endpoint shipped.
 *
 * Going through the REST API makes the dashboard just another client of the
 * documented surface the CLI and every agent already use — so a fix to a
 * handler fixes the dashboard too, and a capability the dashboard needs has to
 * become part of the public contract rather than a private query.
 *
 * Deliberately runtime-agnostic: it takes an access token rather than reaching
 * for a session, so the SAME module serves a browser hook (token from the
 * browser Supabase session) and a server action (token from the cookie
 * session). Nothing here imports `next/*` or a Supabase client.
 */

export type RestQueryValue = string | number | boolean | null | undefined;

export interface RestRequest {
  /** Access token: a Supabase user JWT, or an `lk_*` API token. */
  accessToken: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, RestQueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

/** A non-2xx REST response, carrying whatever the API said about it. */
export class RestApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'RestApiError';
    this.status = status;
    this.code = code;
  }
}

/** Thrown when the API base URL is not configured — a deployment mistake. */
export class RestConfigError extends Error {
  constructor() {
    super('NEXT_PUBLIC_SUPABASE_URL is not set; the LoreKit REST API base URL cannot be derived');
    this.name = 'RestConfigError';
  }
}

/**
 * `https://<ref>.supabase.co/functions/v1` — the edge-function root the REST
 * API is served from.
 *
 * Read as a literal `process.env['…']` member expression so Next.js inlines it
 * into the browser bundle at build time (the same requirement `otel-origins.ts`
 * documents), and resolved per call rather than at module load so a test can
 * set it after import.
 */
export function restBaseUrl(): string {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  if (!url) throw new RestConfigError();
  return `${url.replace(/\/+$/, '')}/functions/v1`;
}

function buildQuery(query: Record<string, RestQueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // An absent filter is omitted, never sent as the string "undefined".
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Read the API's error envelope (`{ error, code }`, see `_shared/api/respond.ts`).
 * Falls back to the status text when the body is empty or not JSON — an edge
 * function that fails to boot answers with an HTML error page, and the caller
 * still deserves a usable message.
 */
async function toRestError(res: Response): Promise<RestApiError> {
  let message = res.statusText || `Request failed with status ${res.status}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof body?.error === 'string') message = body.error;
    if (typeof body?.code === 'string') code = body.code;
  } catch {
    // Non-JSON body — keep the status-derived message.
  }
  return new RestApiError(res.status, message, code);
}

/**
 * How long a single REST call may run before it is abandoned.
 *
 * A `fetch` has no deadline of its own: a connection that is accepted and then
 * goes quiet leaves a promise that never settles, and everything waiting on it
 * waits for the lifetime of the page. That is not a hypothetical here — it is
 * the shape of the "the header keeps claiming the app is loading" bug, where a
 * React Query query stays `fetching` because its request never came back.
 *
 * Generous on purpose. Every route behind this client is a keyset page or a
 * pre-aggregated rollup, so a request that has not answered in 30s is not slow,
 * it is gone — and a timeout is a real error the caller can retry or show,
 * which is strictly more than an unresolved promise offers.
 */
export const REST_TIMEOUT_MS = 30_000;

/**
 * A signal that aborts when the caller's own signal does, or when
 * {@link REST_TIMEOUT_MS} elapses — whichever comes first.
 *
 * Composed by hand rather than with `AbortSignal.any`, which Safari only
 * shipped in 17.4; this client runs in whatever browser the dashboard is open
 * in. `release` must be called once the request settles, or the timer keeps the
 * timeout alive and the listener keeps the caller's signal referencing a
 * controller nobody is waiting on any more.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${ms}ms`, 'TimeoutError')),
    ms,
  );
  const abort = () => controller.abort(signal?.reason);

  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

/**
 * Call a REST route and parse its JSON body.
 *
 * `path` is function-relative and starts with the function name, e.g.
 * `/memories/scopes`. A 204 resolves to `undefined`.
 */
export async function restFetch<T>(path: string, req: RestRequest): Promise<T> {
  const { accessToken, method = 'GET', query, body, signal } = req;

  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const deadline = withTimeout(signal, REST_TIMEOUT_MS);

  try {
    const res = await fetch(`${restBaseUrl()}${path}${buildQuery(query)}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: deadline.signal,
      // Never cache a per-user read: Next's fetch would otherwise serve one
      // user's memories to the next request that happens to match the URL.
      cache: 'no-store',
    });

    if (!res.ok) throw await toRestError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    // In the `finally` so it also runs for a thrown `RestApiError` — the timer
    // must not outlive the request under any exit.
    deadline.release();
  }
}
