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
    const db = svcClient();
    const { data, error } = await db.from('api_tokens').select('user_id,permissions').eq('token_hash', hash).maybeSingle();
    if (error || !data) { span.clientError('invalid_api_key').end(); return null; }
    span.setAttributes({ 'auth.type': 'api_key', 'auth.outcome': 'ok', 'auth.user_id': data.user_id }).end();
    return { auth: { type: 'api_key', userId: data.user_id, permissions: data.permissions ?? [] }, db: svcClient() };
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
