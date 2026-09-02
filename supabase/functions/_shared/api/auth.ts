import { createClient } from 'npm:@supabase/supabase-js@2';
import { SPAN_KIND_CLIENT, type Span } from '../telemetry/otel.ts';
import { normalizeKeyRestriction, type KeyRestriction } from '../auth/tenant-scope.ts';
import type { DbClient } from '../db/db-client.ts';
import type { Database } from '../db/database.types.ts';

export interface AuthContext {
  type: 'user' | 'service' | 'api_key';
  userId?: string;
  jwt?: string;
  permissions?: string[];
  /**
   * api_key only: the scope/org restriction on the calling key (00068). Absent
   * for every other tier — a JWT or service-role caller has no key to restrict,
   * and absent is NOT "restricted to nothing". Read it through
   * `keyRestriction()` so no call site has to remember that.
   */
  keyScoping?: KeyRestriction;
}

/**
 * Re-exported so every existing importer of `DbClient` from this module keeps
 * working. The canonical declaration is `_shared/db/db-client.ts` — see its
 * docblock for why the typed client lives in its own file rather than here.
 */
export type { DbClient };

export interface ResolvedAuth { auth: AuthContext; db: DbClient; }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function sha256(t: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2,'0')).join('');
}

function svcClient(): DbClient { return createClient<Database>(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); }
function userClient(jwt: string): DbClient {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
}

/**
 * Resolve auth from a REST request. Creates a `lorekit.rest.auth` child span
 * so auth latency is visible in traces separately from business logic.
 * Returns null when no valid credentials found (caller should return 401).
 */
export async function resolveRestAuth(req: Request, parentSpan: Span): Promise<ResolvedAuth | null> {
  const span = parentSpan.child('lorekit.rest.auth');
  const raw = req.headers.get('Authorization');
  const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : null;

  if (!token) { span.clientError('missing_token').end(); return null; }

  if (SERVICE_KEY && token === SERVICE_KEY) {
    span.setAttributes({ 'auth.type': 'service', 'auth.outcome': 'ok' }).end();
    return { auth: { type: 'service' }, db: svcClient() };
  }

  if (token.startsWith('lk_')) {
    const hash = await sha256(token);
    // Create one service-role client and reuse it for both the token lookup and
    // subsequent business queries — avoids a second client allocation per request.
    const db = svcClient();
    // The token lookup gets its own CLIENT span, mirroring the MCP counterpart
    // (`mcp/auth.ts`'s `lookupSpan`). Until now this was the ONE network
    // round-trip on this surface with no span of its own — the JWT tier's
    // `auth.getUser()` below got one in #592, but this `lk_*` read stayed a raw
    // `svcClient()` call, so its latency folded into `lorekit.rest.auth`'s
    // undifferentiated self time, indistinguishable from CPU-bound auth work.
    // That is exactly what made a p95 latency spike on the api_key tier
    // unattributable (`api — elevated p95 latency`).
    //
    // Deliberately NOT `createTracedClient`: it interpolates filter VALUES into
    // the span name and `db.query.text` (`buildSql` over `eq()` arguments), and
    // the filter here is the token hash — the stored credential. The query
    // therefore runs on the raw client and only the timing is spanned, same as
    // the MCP counterpart.
    const lookupSpan = span.child('SELECT user_id,permissions,scopes,org_access,org_ids,expires_at FROM api_tokens', {
      'db.system': 'postgresql',
      'db.operation.name': 'SELECT',
      'db.collection.name': 'api_tokens',
    }, SPAN_KIND_CLIENT);
    let data: { user_id: string; permissions: string[] | null; scopes?: unknown; org_access?: unknown; org_ids?: unknown; expires_at?: string | null } | null = null;
    let success = false;
    try {
      const result = await db.from('api_tokens').select('user_id,permissions,scopes,org_access,org_ids,expires_at').eq('token_hash', hash).maybeSingle();
      data = result.data;
      success = !result.error;
      if (result.error) {
        lookupSpan.error(`PostgrestError: ${result.error.code ?? 'unknown'}`);
      }
    } catch (err) {
      // The error NAME only — a Deno fetch failure renders the request URL into
      // its message, and this request's URL carries `token_hash=eq.<sha256>`.
      lookupSpan.error((err as Error).name);
      throw err;
    } finally {
      // `finally`, so a rejected read still exports the span instead of the
      // failing case — the one this span exists to make visible — vanishing.
      lookupSpan.setAttributes({
        'db.response.rows': data ? 1 : 0,
        'db.success': success,
      }).end();
    }
    if (!data) { span.clientError('invalid_api_key').end(); return null; }
    // OAuth-issued tokens expire (00095_oauth.sql). `mcp/auth.ts` already rejects
    // them at the instant they expire rather than leaving it to the nightly
    // sweeper; this surface must not be the softer of the two, or an expired
    // credential keeps working over REST after MCP has stopped accepting it.
    // Personal dashboard tokens carry a NULL `expires_at` and are unaffected.
    const expiresAt = data.expires_at ?? null;
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      span.clientError('expired_api_key').end();
      return null;
    }
    span.setAttributes({ 'auth.type': 'api_key', 'auth.outcome': 'ok', 'auth.user_id': data.user_id }).end();
    return {
      auth: {
        type: 'api_key',
        userId: data.user_id,
        permissions: data.permissions ?? [],
        keyScoping: normalizeKeyRestriction(data),
      },
      db,
    };
  }

  const anonDb = createClient<Database>(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  // `auth.getUser()` is an outbound HTTP call to Supabase's GoTrue Auth API —
  // this tier's ONLY I/O, and until now it had no span of its own (the `lk_`
  // tier's `api_tokens` lookup above is likewise a raw `svcClient()` call with
  // no dedicated span of its own — it is only traced if a caller later wraps
  // the returned `db` in `createTracedClient`).
  // Without it, GoTrue latency was folded into `lorekit.rest.auth`'s
  // undifferentiated self time, indistinguishable from CPU-bound auth work —
  // exactly what made a p95 latency spike on this path unattributable. `finally`,
  // for the same reason every other traced call on this surface uses one: a
  // rejected call must still be exported so the slow/failing case is visible
  // rather than silently dropped.
  const getUserSpan = span.child('lorekit.auth.supabase_get_user', {}, SPAN_KIND_CLIENT);
  let user: Awaited<ReturnType<typeof anonDb.auth.getUser>>['data']['user'] = null;
  let error: Awaited<ReturnType<typeof anonDb.auth.getUser>>['error'] = null;
  try {
    const result = await anonDb.auth.getUser(token);
    user = result.data.user;
    error = result.error;
  } catch (err) {
    getUserSpan.error((err as Error).name);
    throw err;
  } finally {
    getUserSpan.setAttributes({ 'db.success': !error && !!user }).end();
  }
  if (error || !user) { span.clientError('invalid_jwt').end(); return null; }
  span.setAttributes({ 'auth.type': 'user', 'auth.outcome': 'ok', 'auth.user_id': user.id }).end();
  return { auth: { type: 'user', userId: user.id, jwt: token }, db: userClient(token) };
}

export function hasPermission(auth: AuthContext, required: 'read' | 'write'): boolean {
  if (auth.type === 'service' || auth.type === 'user') return true;
  return auth.permissions?.includes(required) ?? false;
}

/**
 * The calling key's restriction, or `undefined` when there is no key.
 *
 * The REST twin of the helper in `mcp/auth.ts`, and the ONE place on this
 * surface where "a JWT caller has no key restriction" is expressed.
 */
export function keyRestriction(auth: AuthContext): KeyRestriction | undefined {
  return auth.type === 'api_key' ? auth.keyScoping : undefined;
}

export function isJwtAuth(auth: AuthContext): boolean {
  return auth.type === 'user';
}

/**
 * The actor to stamp on an `audit_log` row: the resolved user for BOTH
 * `api_key` and user-JWT callers, `null` only for service-role.
 *
 * WHY the JWT branch returns the user (it used to return `null`):
 * `resolveRestAuth` hands a JWT caller `userClient(jwt)` — ANON_KEY plus
 * `Authorization: Bearer <jwt>` — so RLS applies and `auth.uid()` IS that
 * user's id. `audit_log`'s insert policy is
 * `rls_audit_log_insert ... with check (user_id = auth.uid())`
 * (supabase/migrations/00010_audit_log.sql). Supplying the caller's own id is
 * therefore exactly what makes the insert LEGAL; supplying `null` is exactly
 * what made it fail the policy, and `recordAudit` — correctly non-throwing —
 * swallowed the failure, so every JWT-authenticated REST mutation silently
 * lost its audit row. The old reasoning ("mirror MCP's limitation, don't fix
 * it here") is void: it described a behaviour that produced no rows at all,
 * not a comparable one.
 *
 * Service-role stays `null` because there is no human actor to name; that
 * client bypasses RLS, so the row is written with a null actor rather than
 * refused.
 *
 * CONSEQUENCE, stated plainly: REST now attributes JWT callers correctly
 * where MCP (`mcp/auth.ts`'s `getUserId`) still records `null` and still loses
 * those rows. That asymmetry is the remaining bug, and `getUserId` is the side
 * that should converge on this rule — not the reverse.
 *
 * The rule itself lives in the pure, unit-tested `_shared/audit/rest-audit-actor.ts`
 * (mirror of `packages/mcp-core/src/audit/rest-audit-actor.ts`), re-exported here so
 * every existing `import { auditUserId } from '…/api/auth.ts'` is unchanged.
 */
export { auditUserId } from '../audit/rest-audit-actor.ts';

/**
 * The user a usage event is attributed to — unlike `auditUserId` this is the
 * resolved user for BOTH api_key and JWT callers (mirroring `mcp-handler.ts`'s
 * `analyticsUserId`), because `usage_events` is written with the caller's own
 * client and carries no `auth.uid()` RLS predicate. `null` for service-role.
 */
export function analyticsUserId(auth: AuthContext): string | null {
  return auth.type === 'service' ? null : (auth.userId ?? null);
}

/** `usage_events.auth_type` for a REST caller. */
export function usageAuthType(auth: AuthContext): 'api_key' | 'jwt' | 'service' {
  if (auth.type === 'api_key') return 'api_key';
  if (auth.type === 'service') return 'service';
  return 'jwt';
}

/**
 * The actor to pass as `p_actor_user_id` to an org RPC (migration
 * `00041_org_actor_override.sql`).
 *
 * Org RPCs resolve the acting user through `lorekit_org_actor(p_actor_user_id)`,
 * which honours the parameter ONLY on a verified `service_role` connection and
 * otherwise falls back to `auth.uid()`. The `api_key` tier talks to Postgres
 * with the service-role key and therefore has no `auth.uid()` at all, so
 * without this the RPC's `lorekit_org_can(null, …)` denies every call.
 *
 * The value is never taken from the request: `resolveRestAuth` sets
 * `auth.userId` from the `api_tokens` row it matched by token hash (or from the
 * verified JWT), so a caller can only ever act as the identity its credential
 * belongs to. `service` auth has no user at all and resolves to `null`, which
 * makes every capability check fail closed — CI keeps its RLS bypass for direct
 * table access, but does not get to act as an anonymous org admin.
 *
 * This exists as ONE helper rather than an inlined `auth.userId ?? null` at each
 * call site so a new org handler cannot quietly forget it (the omission is
 * invisible under JWT auth and only breaks the api_key tier). Enforced by
 * `packages/mcp-core/src/auth/org-actor-usage.spec.ts`.
 */
export function actorUserId(auth: AuthContext): string | null {
  return auth.userId ?? null;
}
