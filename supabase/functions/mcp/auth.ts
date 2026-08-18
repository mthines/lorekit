/**
 * Authentication utilities for the LoreKit MCP Edge Function.
 *
 * Three-tier auth, evaluated in order:
 *   1. SUPABASE_SERVICE_ROLE_KEY — full access, bypasses RLS (CI/internal)
 *   2. lk_rw_* / lk_ro_* / lk_wo_* API tokens — user-scoped via SHA-256 lookup
 *   3. Supabase JWT — user-scoped via auth.getUser()
 *
 * Every call to resolveAuth() produces child span attributes on the provided
 * parent Span so the auth outcome is visible in traces without log-digging.
 * Callers should pass the root span from traceRequest() via the optional `span`
 * parameter; when omitted, no extra attributes are set.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { extractToken } from './auth-token.ts';
import { SPAN_KIND_CLIENT, type Span } from '../_shared/otel.ts';
import { normalizeKeyRestriction, type KeyRestriction } from '../_shared/tenant-scope.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export interface AuthContext {
  type: 'user' | 'service' | 'api_key';
  userId?: string;
  jwt?: string;
  /** api_key only: ['read'], ['write'], or ['read', 'write'] */
  permissions?: string[];
  /**
   * api_key only: the key's scope/org restriction (migration 00068).
   *
   * Absent for every other tier, and absent is NOT "restricted to nothing" — a
   * JWT or service-role caller has no key to restrict. `keyRestriction(auth)`
   * below is the one place that distinction is read, so no call site has to
   * remember it.
   */
  keyScoping?: KeyRestriction;
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve the caller's auth context, TIMED.
 *
 * The outcome attributes still land on the caller's span exactly as before —
 * `mcp/index.ts` passes the root request span on purpose so `auth.type` /
 * `auth.outcome` / `auth.user_id` are queryable on the request itself. That
 * decision is unchanged; what is added here is the missing DURATION.
 *
 * Auth resolution is a network round-trip on two of the three tiers (an
 * `api_tokens` select for `lk_*`, a GoTrue call for a JWT) and it emitted no
 * span at all, so its cost was unattributable wall clock inside the request
 * span: `lorekit.mcp` spans reporting 0.885s with 0.084s accounted for by
 * children. The REST surface has had this since it shipped (`lorekit.rest.auth`,
 * `_shared/api/auth.ts`); this is the MCP counterpart.
 *
 * The `try`/`finally` is what makes it safe: the tier logic has six return
 * paths and an `.end()` per path is one refactor away from being dropped on the
 * one that matters.
 */
export async function resolveAuth(
  authHeader: string | null,
  queryToken: string | null = null,
  span?: Span,
): Promise<AuthContext | null> {
  const authSpan = span?.child('lorekit.mcp.auth');
  try {
    return await resolveAuthTiers(authHeader, queryToken, span, authSpan);
  } catch (err) {
    // Without this arm the span's status stays at its `ok` default, so a failed
    // resolution renders as an OK `lorekit.mcp.auth` parent above an errored
    // child — the one shape that makes the tree lie about which hop broke.
    // `traceRequest` uses exactly this catch-record-rethrow-finally form.
    // The error NAME only, for the reason the token lookup states: a fetch
    // failure's message carries the request URL, and that URL carries the
    // token hash.
    authSpan?.error((err as Error).name);
    throw err;
  } finally {
    authSpan?.end();
  }
}

async function resolveAuthTiers(
  authHeader: string | null,
  queryToken: string | null,
  span: Span | undefined,
  authSpan: Span | undefined,
): Promise<AuthContext | null> {
  // Accept token from Authorization: Bearer header (preferred — keeps the token
  // out of server logs) or ?token= query param (legacy fallback for MCP clients
  // that cannot inject custom headers). extractToken() implements the precedence.
  const token = extractToken(authHeader, queryToken);
  if (!token) {
    span?.setAttributes({ 'auth.outcome': 'missing_token', 'auth.type': 'none' });
    return null;
  }

  // 1. Service-role key — CI / internal use only
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) {
    span?.setAttributes({ 'auth.outcome': 'service_role', 'auth.type': 'service' });
    return { type: 'service' };
  }

  // 2. LoreKit API token (lk_rw_..., lk_ro_..., or lk_wo_...)
  if (token.startsWith('lk_')) {
    const hash = await sha256hex(token);
    const serviceDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // The token lookup gets its own CLIENT span, like every other edge DB call,
    // so a slow `api_tokens` read is distinguishable from a slow hash or a slow
    // GoTrue call rather than being one undifferentiated auth cost.
    //
    // Deliberately NOT `createTracedClient`: it renders filter VALUES into the
    // span name and `db.query.text` (`buildSql` interpolates `eq()` arguments),
    // and the filter here is the token hash — the stored credential. The query
    // therefore runs on the raw client and only the timing is spanned.
    const lookupSpan = authSpan?.child('SELECT user_id,permissions,scopes,org_access,org_ids FROM api_tokens', {
      'db.system': 'postgresql',
      'db.operation.name': 'SELECT',
      'db.collection.name': 'api_tokens',
    }, SPAN_KIND_CLIENT);
    // `finally`, for the reason the outer `authSpan` uses one: `Span.end()` is
    // the only thing that enqueues a span for export, so a lookup that REJECTS
    // (transport failure, abort) would drop the child entirely and the failing
    // case — the one this span exists to make visible — would vanish. This
    // mirrors `TracedQuery`'s rejection handler in `_shared/otel.ts`. The
    // rejection is rethrown untouched: an infra outage must not be reported as
    // an invalid key.
    //
    // `db.success` (and the error status) is what keeps a FAILED read
    // distinguishable from a genuine token miss: both leave `data` null and
    // both end in `api_key_invalid`, so rows-0 alone reports an outage as a bad
    // key. `TracedQuery` records the same pair for every other edge DB call.
    // The bounded error CODE goes on the span, never the free-form message —
    // the same rule the JWT tier below states explicitly, and the reason this
    // query avoids `createTracedClient` in the first place.
    let data: Record<string, unknown> | null = null;
    let success = false;
    try {
      const result = await serviceDb
        .from('api_tokens')
        .select('user_id, permissions, scopes, org_access, org_ids')
        .eq('token_hash', hash)
        .maybeSingle();
      data = result.data;
      success = !result.error;
      if (result.error) {
        lookupSpan?.error(`PostgrestError: ${result.error.code ?? 'unknown'}`);
      }
    } catch (err) {
      // The error NAME only — same bounded-value rule as the PostgREST arm
      // above, and for a sharper reason: a Deno fetch failure renders the
      // request URL into its message, and this request's URL carries
      // `token_hash=eq.<sha256>`. The free-form message would publish the
      // stored credential to telemetry — the exact leak this query avoids
      // `createTracedClient` to prevent. Name plus `db.success: false` plus the
      // span's own duration already separate a transport failure from a miss.
      lookupSpan?.error((err as Error).name);
      throw err;
    } finally {
      lookupSpan?.setAttributes({
        'db.response.rows': data ? 1 : 0,
        'db.success': success,
      }).end();
    }
    if (!data) {
      span?.setAttributes({ 'auth.outcome': 'api_key_invalid', 'auth.type': 'api_key' });
      return null;
    }
    // Best-effort last_used_at bump — don't block the response on it, but hand
    // it to EdgeRuntime.waitUntil so the isolate stays alive until the write
    // commits. A bare fire-and-forget is dropped when the isolate freezes right
    // after the response returns, so the timestamp never lands (same reason the
    // OTel flush in _shared/otel.ts uses waitUntil).
    const lastUsedUpdate = Promise.resolve(
      serviceDb
        .from('api_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('token_hash', hash),
    ).catch(() => { /* swallow — timestamp is best-effort */ });
    const edgeRuntime = (globalThis as {
      EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (typeof edgeRuntime?.waitUntil === 'function') {
      edgeRuntime.waitUntil(lastUsedUpdate);
    } else {
      void lastUsedUpdate;
    }
    span?.setAttributes({
      'auth.outcome': 'api_key_valid',
      'auth.type': 'api_key',
      'auth.user_id': data.user_id as string,
    });
    return {
      type: 'api_key',
      userId: data.user_id as string,
      permissions: data.permissions as string[],
      keyScoping: normalizeKeyRestriction(data),
    };
  }

  // 3. Supabase user JWT (browser session)
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    // Use bounded error code, not the free-form message, to avoid PII leaking into span attributes.
    span?.setAttributes({
      'auth.outcome': 'jwt_invalid',
      'auth.type': 'jwt',
      'auth.error_code': error?.code ?? error?.name ?? 'no_user',
    });
    return null;
  }
  span?.setAttributes({
    'auth.outcome': 'jwt_valid',
    'auth.type': 'jwt',
    'auth.user_id': data.user.id,
  });
  return { type: 'user', userId: data.user.id, jwt: token };
}

export function getDb(auth: AuthContext) {
  // service + api_key both use service-role; api_key queries MUST add .eq('user_id', userId)
  if (auth.type === 'service' || auth.type === 'api_key') {
    return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  // User JWT — RLS enforced automatically
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${auth.jwt!}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Returns true if the auth context allows write operations. */
export function canWrite(auth: AuthContext): boolean {
  if (auth.type === 'service' || auth.type === 'user') return true;
  return (auth.permissions ?? []).includes('write');
}

/** Returns true if the auth context allows read operations. */
export function canRead(auth: AuthContext): boolean {
  if (auth.type === 'service' || auth.type === 'user') return true;
  return (auth.permissions ?? []).includes('read');
}

/** userId to pass to tool handlers — null means RLS handles scoping. */
export function getUserId(auth: AuthContext): string | null {
  return auth.type === 'api_key' ? (auth.userId ?? null) : null;
}

/**
 * The calling key's restriction, or `undefined` when there is no key.
 *
 * The mirror of `getUserId`, and the ONE place "a JWT caller has no key
 * restriction" is expressed — so no call site can accidentally read a missing
 * restriction as an empty one and start denying a dashboard session.
 */
export function keyRestriction(auth: AuthContext): KeyRestriction | undefined {
  return auth.type === 'api_key' ? auth.keyScoping : undefined;
}

/**
 * Returns true iff the caller has a Supabase user JWT session.
 * org.* tools require this so auth.uid() resolves inside SECURITY DEFINER RPCs.
 * api_key and service callers have no session JWT and must be rejected.
 */
export function isJwtAuth(auth: AuthContext): boolean {
  return auth.type === 'user';
}
