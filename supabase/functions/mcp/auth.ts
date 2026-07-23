/**
 * Authentication utilities for the LoreKit MCP Edge Function.
 *
 * Three-tier auth, evaluated in order:
 *   1. SUPABASE_SERVICE_ROLE_KEY — full access, bypasses RLS (CI/internal)
 *   2. lk_rw_* / lk_ro_* API tokens — user-scoped via SHA-256 lookup
 *   3. Supabase JWT — user-scoped via auth.getUser()
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export interface AuthContext {
  type: 'user' | 'service' | 'api_key';
  userId?: string;
  jwt?: string;
  /** api_key only: ['read'] or ['read', 'write'] */
  permissions?: string[];
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function resolveAuth(authHeader: string | null): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  // 1. Service-role key — CI / internal use only
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) return { type: 'service' };

  // 2. LoreKit API token (lk_rw_... or lk_ro_...)
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
    if (!data) return null;
    // Fire-and-forget — don't block the response for a timestamp update
    void serviceDb
      .from('api_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('token_hash', hash);
    return {
      type: 'api_key',
      userId: data.user_id as string,
      permissions: data.permissions as string[],
    };
  }

  // 3. Supabase user JWT (browser session)
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
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

/** userId to pass to tool handlers — null means RLS handles scoping. */
export function getUserId(auth: AuthContext): string | null {
  return auth.type === 'api_key' ? (auth.userId ?? null) : null;
}
