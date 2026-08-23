import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId, keyRestriction } from '../../_shared/api/auth.ts';
import { accountWideRefusalMessage, isRefusedForScopedKey } from '../../_shared/auth/account-wide-tools.ts';
import { recordAudit } from '../../_shared/audit/audit.ts';
import { ok, forbidden, tooManyRequests, dryRun } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import { validateOptionalBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { PurgeMemoriesBodySchema } from '../../_shared/schemas/memory.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/db/database.types.ts';

type RateLimitRow = Database['public']['Functions']['lorekit_check_rate_limit']['Returns'][number];

/**
 * Both purge endpoints are inherently user-scoped: the underlying RPCs take a
 * `p_user_id` and the MCP equivalents (`toolPurge` / `toolPurgeExpired`) throw
 * outright without one. A service-role caller has no user id, so it cannot
 * address either operation.
 *
 * That is a 403, not a 400. The request itself is well-formed — nothing the
 * caller could put in the body or query string would make it valid; it is the
 * *credential* that cannot express the target of the operation. This is exactly
 * the shape of the router's existing `requires: 'jwt'` refusal ("This endpoint
 * requires a Supabase JWT (not an API token)"), which also answers 403 for a
 * credential-type mismatch. Returning 400 would tell a client to fix its
 * payload, which would send it in circles.
 *
 * It is deliberately NOT enforced as a `requires` permission in the route table:
 * `hasPermission` grades read/write scopes on the token, not whether an actor
 * was resolved, and service-role passes every one of them.
 */
function requireUserId(auth: AuthContext, cors: Record<string, string>): string | Response {
  if (!auth.userId) {
    return forbidden('Purge requires a user-scoped credential (service-role tokens have no user to purge)', cors);
  }
  return auth.userId;
}

/**
 * The REST half of the account-wide-sweep refusal (00068).
 *
 * `docs/api-tokens.md` says a scoped token is refused an account-wide sweep on
 * BOTH surfaces; only the MCP dispatcher enforced it, so these two endpoints
 * were the documented-but-unimplemented half. The decision itself is not
 * restated here — `isRefusedForScopedKey` and the message come from the one
 * `_shared/auth/account-wide-tools.ts` module the MCP dispatcher also calls, keyed on
 * the same tool name `rest-tool-name.ts` already maps these routes to.
 *
 * A 403 for the same reason the router's `requires` refusals are: the request is
 * well-formed and nothing in it could be changed to make it valid — it is the
 * credential that may not address the operation. Returns null for an unscoped
 * token, so a key nobody scoped is byte-for-byte unaffected.
 */
function refuseAccountWideSweep(
  auth: AuthContext, toolName: string, span: Span, cors: Record<string, string>,
): Response | null {
  const hasAllowlist = (keyRestriction(auth)?.scopes.length ?? 0) > 0;
  if (!isRefusedForScopedKey(toolName, hasAllowlist)) return null;
  span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_account_wide' });
  return forbidden(accountWideRefusalMessage(toolName), cors);
}

/**
 * Rate-limit guard, identical in shape to handlers/create.ts. Purge is a bulk
 * destructive operation, so it is gated on the same per-user window as writes.
 * Returns a 429 Response when blocked, otherwise null.
 */
async function checkRateLimit(db: DbClient, span: Span, userId: string, cors: Record<string, string>): Promise<Response | null> {
  const rlSpan = span.child('lorekit.rest.rate_limit');
  const tracedRl = createTracedClient(db, rlSpan);
  const { data: rlData } = await tracedRl.rpc<RateLimitRow>('lorekit_check_rate_limit', { p_user_id: userId, p_window_seconds: 60 });
  const rows = rlData as RateLimitRow[] | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  rlSpan.setAttributes({ 'rate_limit.allowed': !!row?.allowed, 'rate_limit.current': row?.current_count ?? 0 }).end();
  if (row && !row.allowed) return tooManyRequests(row.retry_after_seconds ?? 60, cors);
  return null;
}

/**
 * POST /memories/purge — hard-delete archived memories older than
 * `retention_days`. Mirrors the MCP `memory.purge` tool (toolPurge): same
 * `purge_archived_memories(p_user_id, p_retention_days)` RPC, same
 * `{ purged: <number> }` return. The 1–365 clamp toolPurge does with
 * Math.min/Math.max is done by PurgeMemoriesBodySchema here — over HTTP an
 * out-of-range value is a client error worth reporting, not something to
 * silently round.
 *
 * Audits one SUMMARY `memory.delete` event per run when anything was purged —
 * the same shape toolPurge uses (`target: "<n> archived memories"`, metadata
 * `{ purged, retention_days }`). The RPC returns only a count, never the purged
 * rows, so a per-row event is not possible on either surface.
 */
export async function handlePurge(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  const v = await validateOptionalBody(req, PurgeMemoriesBodySchema, cors);
  if (!v.ok) return v.response;
  const retentionDays = v.data.retention_days;

  span.setAttributes({
    'lorekit.operation': 'memories.purge',
    'lorekit.purge.retention_days': retentionDays,
    'lorekit.scope.type': 'user',
  });

  const refused = refuseAccountWideSweep(auth, 'memory.purge', span, cors);
  if (refused) return refused;

  const limited = await checkRateLimit(db, span, userId, cors);
  if (limited) return limited;

  // Dry-run: validated + authorized + rate-limited above; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('purge_archived_memories', {
    p_user_id: userId,
    p_retention_days: retentionDays,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  // The RPC returns a bare bigint; TracedQuery types every result as a row array,
  // so unwrap through `unknown` rather than lying about the shape.
  const purged = Number((data as unknown) ?? 0);
  span.setAttributes({ 'lorekit.result.purged': purged });
  if (purged > 0) {
    await recordAudit(
      db,
      {
        action: 'memory.delete',
        resourceType: 'memory',
        target: `${purged} archived memories`,
        metadata: { purged, retention_days: retentionDays },
      },
      auditUserId(auth),
      span,
    );
  }
  return ok({ purged }, cors);
}

/**
 * POST /memories/purge-expired — hard-delete memories whose TTL has elapsed.
 * Mirrors the MCP `memory.purge_expired` tool (toolPurgeExpired). Takes no
 * body: the RPC's only input is the user id.
 *
 * Audits one summary `memory.delete` event per run when anything was purged,
 * matching toolPurgeExpired's shape (`target: "<n> expired memories"`,
 * metadata `{ purged_expired }`).
 */
export async function handlePurgeExpired(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  span.setAttributes({ 'lorekit.operation': 'memories.purge_expired', 'lorekit.scope.type': 'user' });

  const refused = refuseAccountWideSweep(auth, 'memory.purge_expired', span, cors);
  if (refused) return refused;

  const limited = await checkRateLimit(db, span, userId, cors);
  if (limited) return limited;

  // Dry-run: validated + authorized + rate-limited above; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('purge_expired_memories', { p_user_id: userId });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  // The RPC returns a bare bigint; TracedQuery types every result as a row array,
  // so unwrap through `unknown` rather than lying about the shape.
  const purged = Number((data as unknown) ?? 0);
  span.setAttributes({ 'lorekit.result.purged_expired': purged });
  if (purged > 0) {
    await recordAudit(
      db,
      {
        action: 'memory.delete',
        resourceType: 'memory',
        target: `${purged} expired memories`,
        metadata: { purged_expired: purged },
      },
      auditUserId(auth),
      span,
    );
  }
  return ok({ purged }, cors);
}
