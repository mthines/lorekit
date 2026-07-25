'use server';

/**
 * Server actions for API token management.
 * All actions validate the user session before operating.
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';

export type TokenPermission = 'read' | 'write';

export interface ApiToken {
  id: string;
  name: string;
  token_prefix: string;
  permissions: TokenPermission[];
  last_used_at: string | null;
  created_at: string;
}

/** Random alphanumeric string of given length. */
function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/** SHA-256 hex of a string — matches the Deno implementation in the Edge Function. */
async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a new API token. Returns the full token string ONCE — it is not
 * stored in plain text and cannot be retrieved again.
 */
const MAX_TOKENS_PER_USER = 20;

export async function generateToken(
  name: string,
  permissions: TokenPermission[],
): Promise<{ token: string; record: ApiToken } | { error: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };
  if (!name.trim()) return { error: 'Token name is required' };

  // Enforce per-user token cap
  const { count, error: countError } = await supabase
    .from('api_tokens')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);
  if (countError) return { error: countError.message };
  if ((count ?? 0) >= MAX_TOKENS_PER_USER) {
    return { error: `Maximum ${MAX_TOKENS_PER_USER} tokens per user. Revoke an existing token first.` };
  }

  // Build token: lk_rw_<32> or lk_ro_<32>
  const permSuffix = permissions.includes('write') ? 'rw' : 'ro';
  const random = randomAlphanumeric(32);
  const fullToken = `lk_${permSuffix}_${random}`;
  const prefix = fullToken.slice(0, 12) + '...'; // "lk_rw_aBcD1..."
  const hash = await sha256hex(fullToken);

  const { data, error } = await supabase
    .from('api_tokens')
    .insert({
      user_id: user.id,
      name: name.trim(),
      token_prefix: prefix,
      token_hash: hash,
      permissions,
    })
    .select('id, name, token_prefix, permissions, last_used_at, created_at')
    .single();

  if (error) return { error: error.message };

  const record = data as ApiToken;
  // Audit metadata is limited to the name + prefix — NEVER the raw token or
  // its hash, so the trail can never leak a usable credential.
  await recordAuditEvent({
    action: 'api_key.create',
    resourceType: 'api_token',
    resourceId: record.id,
    target: record.name,
    metadata: { name: record.name, token_prefix: record.token_prefix },
  });

  revalidatePath('/dashboard');
  // 'layout' so nested /settings/* pages (where tokens actually render) revalidate,
  // not just the /settings redirect page.
  revalidatePath('/settings', 'layout');
  return { token: fullToken, record };
}

/** List all tokens for the current user. Returns [] on auth failure or DB error. */
export async function listTokens(): Promise<ApiToken[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('api_tokens')
    .select('id, name, token_prefix, permissions, last_used_at, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[listTokens] DB error:', error.message);
    return [];
  }
  return (data ?? []) as ApiToken[];
}

/** Revoke (delete) a token by ID. */
export async function revokeToken(tokenId: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // Fetch name + prefix before the delete so the audit event has a
  // human-readable target — the row is gone by the time we'd otherwise ask.
  const { data: existing } = await supabase
    .from('api_tokens')
    .select('name, token_prefix')
    .eq('id', tokenId)
    .eq('user_id', user.id)
    .maybeSingle();

  const { error } = await supabase
    .from('api_tokens')
    .delete()
    .eq('id', tokenId)
    .eq('user_id', user.id); // Ensure ownership

  if (error) return { error: error.message };

  if (existing) {
    await recordAuditEvent({
      action: 'api_key.revoke',
      resourceType: 'api_token',
      resourceId: tokenId,
      target: existing.name as string,
      metadata: { name: existing.name, token_prefix: existing.token_prefix },
    });
  }

  revalidatePath('/dashboard');
  revalidatePath('/settings', 'layout');
  return {};
}
