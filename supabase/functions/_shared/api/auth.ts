/**
 * Authentication for LoreKit REST Edge Functions.
 *
 * Promoted from supabase/functions/mcp/auth.ts — same three-tier logic,
 * extracted so both the MCP function and all REST functions share one
 * implementation (not mirrored copies).
 *
 * Three-tier auth, evaluated in order:
 *   1. SUPABASE_SERVICE_ROLE_KEY — full access, bypasses RLS (CI only)
 *   2. lk_rw_* / lk_ro_* / lk_wo_* API tokens — user-scoped via SHA-256 lookup
 *   3. Supabase JWT — user-scoped, RLS enforced automatically
 *
 * SECURITY: api_key auth returns a service-role DB client. Every query using
 * this client MUST include .eq('user_id', userId) — otherwise users can
 * read each other's memories. Always call getUserId() and pass the result
 * to applyTenantScope().
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Span } from '../otel.ts';

export interface AuthContext {
  type: 'user' | 'service' | 'api_key';
  userId?: string;
  jwt?: string;
  /** api_key only: ['read'], ['write'], or ['read', 'write'] */
  permissions?: string[];
}

function getEnv(key: string): string {
  return Deno.env.get(key) ?? '';
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function waitUntil(p: Promise<unknown>): void {
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (typeof er?.waitUntil === 'function') er.waitUntil(p);
  else void p;
}

/**
 * Resolve auth from the incoming request's Authorization header.
 * Returns null when the token is missing or invalid.
 */
export async function resolveAuth(req: Request, span?: Span): Promise<AuthContext | null> {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_ANON_KEY = getEnv('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  const authHeader = req.headers.get('Authorization');
  let token: string | null = null;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim() || null;
  }
  // Fallback: ?token= query param (legacy support, kept for compatibility)
  if (!token) {
    token = new URL(req.url).searchParams.get('token');
  }

  if (!token) {
    span?.setAttributes({ 'auth.outcome': 'missing_token', 'auth.type': 'none' });
    return null;
  }

  // 1. Service-role key
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) {
    span?.setAttributes({ 'auth.outcome': 'service_role', 'auth.type': 'service' });
    return { type: 'service' };
  }

  // 2. LoreKit API token
  if (token.startsWith('lk_')) {
    const hash = await sha256hex(token);
    const serviceDb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await serviceDb
      .from('api_tokens')
      .select('user_id, permissions')
      .eq('token_hash', hash)
      .maybeSingle();
    if (!data) {
      span?.setAttributes({ 'auth.outcome': 'api_key_invalid', 'auth.type': 'api_key' });
      return null;
    }
    // Best-effort last_used_at bump — fire and forget
    waitUntil(
      serviceDb
        .from('api_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('token_hash', hash)
        .then(() => { /* noop */ })
        .catch(() => { /* swallow */ }),
    );
    span?.setAttributes({
      'auth.outcome': 'api_key_valid',
      'auth.type': 'api_key',
      'auth.user_id': data.user_id as string,
    });
    return {
      type: 'api_key',
      userId: data.user_id as string,
      permissions: data.permissions as string[],
    };
  }

  // 3. Supabase JWT
  const SUPABASE_URL2 = SUPABASE_URL;
  const client = createClient(SUPABASE_URL2, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) {
    span?.setAttributes({
      'auth.outcome': 'jwt_invalid',
      'auth.type': 'jwt',
      'auth.error_code': error?.code ?? error?.name ?? 'no_user',
    });
    return null;
  }
  span?.setAttributes({ 'auth.outcome': 'jwt_valid', 'auth.type': 'jwt', 'auth.user_id': data.user.id });
  return { type: 'user', userId: data.user.id, jwt: token };
}

/** Returns the DB client appropriate for the auth context. */
export function getDb(auth: AuthContext) {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_ANON_KEY = getEnv('SUPABASE_ANON_KEY');
  const SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (auth.type === 'service' || auth.type === 'api_key') {
    return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${auth.jwt!}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** userId to pass to DB queries when using a service-role client (api_key auth). */
export function getUserId(auth: AuthContext): string | null {
  return auth.type === 'api_key' ? (auth.userId ?? null) : null;
}

/** True when the auth context permits write operations. */
export function canWrite(auth: AuthContext): boolean {
  if (auth.type === 'service' || auth.type === 'user') return true;
  return (auth.permissions ?? []).includes('write');
}

/** True when the auth context permits read operations. */
export function canRead(auth: AuthContext): boolean {
  if (auth.type === 'service' || auth.type === 'user') return true;
  return (auth.permissions ?? []).includes('read');
}

/**
 * True when the caller has a Supabase user JWT session.
 * Required for org.* operations (auth.uid() resolves inside SECURITY DEFINER RPCs).
 */
export function isJwtAuth(auth: AuthContext): boolean {
  return auth.type === 'user';
}
