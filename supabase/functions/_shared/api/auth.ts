import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Span } from '../otel.ts';

export interface AuthContext {
  type: 'user' | 'service' | 'api_key';
  userId?: string;
  jwt?: string;
  permissions?: string[];
}

export type DbClient = ReturnType<typeof createClient>;

export interface ResolvedAuth { auth: AuthContext; db: DbClient; }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function sha256(t: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2,'0')).join('');
}

function svcClient(): DbClient { return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }); }
function userClient(jwt: string): DbClient {
  return createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
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
    const { data, error } = await db.from('api_tokens').select('user_id,permissions').eq('token_hash', hash).maybeSingle();
    if (error || !data) { span.clientError('invalid_api_key').end(); return null; }
    span.setAttributes({ 'auth.type': 'api_key', 'auth.outcome': 'ok', 'auth.user_id': data.user_id }).end();
    return { auth: { type: 'api_key', userId: data.user_id, permissions: data.permissions ?? [] }, db };
  }

  const anonDb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error } = await anonDb.auth.getUser(token);
  if (error || !user) { span.clientError('invalid_jwt').end(); return null; }
  span.setAttributes({ 'auth.type': 'user', 'auth.outcome': 'ok', 'auth.user_id': user.id }).end();
  return { auth: { type: 'user', userId: user.id, jwt: token }, db: userClient(token) };
}

export function hasPermission(auth: AuthContext, required: 'read' | 'write'): boolean {
  if (auth.type === 'service' || auth.type === 'user') return true;
  return auth.permissions?.includes(required) ?? false;
}

export function isJwtAuth(auth: AuthContext): boolean {
  return auth.type === 'user';
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
 * `packages/mcp-core/src/org-actor-usage.spec.ts`.
 */
export function actorUserId(auth: AuthContext): string | null {
  return auth.userId ?? null;
}
