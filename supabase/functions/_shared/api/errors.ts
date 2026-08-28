export class RestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RestError';
  }

  toResponse(cors: Record<string, string> = {}): Response {
    return new Response(
      JSON.stringify({ error: this.message, ...(this.code ? { code: this.code } : {}), ...(this.details ? { details: this.details } : {}) }),
      { status: this.status, headers: { 'Content-Type': 'application/json', ...cors } },
    );
  }
}

/**
 * PostgREST's own JWT-validation error messages. Raised straight from
 * PostgREST when it verifies the `Authorization: Bearer <jwt>` header on an
 * RPC/table call made through the user-scoped client (`userClient(jwt)` in
 * `auth.ts`) — a DIFFERENT verification pass than `resolveRestAuth`'s own
 * `anonDb.auth.getUser(token)` upstream, which runs before this point and
 * would normally already have rejected a genuinely invalid token there.
 * These fire on a narrow *clock-skew* window: the token was valid when
 * `getUser` checked it, but by the time PostgREST verifies it independently
 * (e.g. `iat` vs. PostgREST's own server clock; Supabase's GoTrue and
 * PostgREST are two separate processes with two separate clocks), a
 * few-hundred-millisecond drift flips the check. PostgREST reports these with
 * no `code` (or an empty string) — the message is the only signal — and the
 * HTTP status it uses itself is 401, matching a REST auth failure exactly.
 * Without this, the RPC call throws, `translateDbError` doesn't recognise it,
 * and the request falls through to `internalError` (500): a transient,
 * retryable auth condition on the caller's side surfaces as a server fault,
 * which is exactly what inflated the `API - Elevated error count` check
 * (`bb2e9fc6-916a-4039-aa75-209b50ecac57`) for `service.name=api` on
 * `GET /memories/scopes` and `GET /memories`.
 */
const POSTGREST_JWT_ERROR = /^JWT (issued at future|expired|not yet valid|invalid)/i;

/** Map well-known Postgres SQLSTATEs / PostgREST codes to HTTP errors. */
export function translateDbError(err: unknown): RestError | null {
  const e = err as { code?: string; message?: string; error?: { code?: string; message?: string } } | null | undefined;
  const code = e?.code ?? e?.error?.code;
  const message = e?.message ?? e?.error?.message;
  if (code === 'LK001') return new RestError('Memory limit exceeded. Archive unused memories or upgrade your plan.', 429, 'memory_cap');
  if (code === 'LK002') return new RestError('Insufficient permissions for this org action.', 403, 'org_permission_denied');
  if (code === 'PGRST116') return new RestError('Not found', 404, 'not_found');
  if (code === '23505') return new RestError('A record with this identifier already exists.', 409, 'conflict');
  if (typeof message === 'string' && POSTGREST_JWT_ERROR.test(message)) {
    return new RestError('Your session token could not be verified (it may be expired or affected by clock skew). Please sign in again and retry.', 401, 'invalid_jwt');
  }
  return null;
}
