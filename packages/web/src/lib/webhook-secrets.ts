'use server';

/**
 * Server actions for webhook secret management.
 *
 * The secret is a 32-byte random value stored as 64 hex chars.
 * It is stored in plaintext because the edge function must read the raw value
 * on every webhook call to recompute HMAC-SHA256. This is safe: the DB is the
 * Supabase trust boundary, and RLS restricts reads to the owning user.
 *
 * Pattern mirrors lib/tokens.ts (generateToken / listTokens / revokeToken).
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

export interface WebhookSecret {
  id: string;
  secret: string;
  active: boolean;
  created_at: string;
}

/** Generate a 32-byte hex secret using the Web Crypto API. */
function randomHex64(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get the active webhook secret for the current user.
 * Returns null if none exists yet (first-time setup).
 */
export async function getActiveWebhookSecret(): Promise<WebhookSecret | null> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('webhook_secrets')
    .select('id, secret, active, created_at')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[getActiveWebhookSecret] DB error:', error.message);
    return null;
  }
  return data as WebhookSecret | null;
}

/**
 * Generate a new webhook secret.
 * Deactivates the previous active secret so in-flight webhook deliveries
 * still have a short window to succeed before the old secret is superseded.
 *
 * Returns the full secret value — callers should display it once prominently.
 */
export async function generateWebhookSecret(): Promise<
  { secret: string; id: string } | { error: string }
> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const secret = randomHex64();

  // Deactivate previous secrets
  await supabase
    .from('webhook_secrets')
    .update({ active: false })
    .eq('user_id', user.id)
    .eq('active', true);

  // Insert the new active secret
  const { data, error } = await supabase
    .from('webhook_secrets')
    .insert({ user_id: user.id, secret, active: true })
    .select('id, created_at')
    .single();

  if (error) return { error: error.message };

  revalidatePath('/dashboard');
  return { secret, id: (data as { id: string }).id };
}
