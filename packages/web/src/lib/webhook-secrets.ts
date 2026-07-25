'use server';

/**
 * Server actions for per-repo webhook secret management.
 *
 * The secret is a 32-byte random value stored as 64 hex chars.
 * It is stored in plaintext because the edge function must read the raw value
 * on every webhook call to recompute HMAC-SHA256. This is safe: the DB is the
 * Supabase trust boundary, and RLS restricts reads to the owning user.
 *
 * These are dashboard server actions authenticated by the Supabase user JWT —
 * RLS (user_id = auth.uid()) scopes every query to the caller's own rows.
 * The `lk_rw_*` API-token rule (CLAUDE.md) applies to MCP `api_key` tool
 * calls, not these server actions.
 *
 * Secrets are now scoped per repository (repo::owner/name) — a user can
 * register a secret for each repo they webhook, matching the edge lookup's
 * full_name-based resolution (packages/mcp-core/src/webhook-secret-select.ts).
 *
 * Pattern mirrors lib/tokens.ts (generateToken / listTokens / revokeToken).
 */

import { createServerClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { normalizeRepo } from '@/lib/repo-format';

export interface WebhookSecret {
  id: string;
  secret: string;
  repo: string | null;
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
 * List the current user's active webhook secrets, one per registered repo
 * (plus any legacy null-repo row from before per-repo secrets existed).
 * Returns [] on auth failure or DB error.
 */
export async function listWebhookSecrets(): Promise<WebhookSecret[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('webhook_secrets')
    .select('id, secret, repo, active, created_at')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[listWebhookSecrets] DB error:', error.message);
    return [];
  }
  return (data ?? []) as WebhookSecret[];
}

/**
 * Generate a new webhook secret for a specific repo.
 *
 * Validates the repo format, deactivates only the prior active secret for
 * that (user, repo) pair — other repos' secrets are untouched — so in-flight
 * webhook deliveries for other repos aren't affected, and deliveries for the
 * same repo have a short grace window on the old secret before GitHub's
 * retries catch up.
 *
 * Returns the full secret value — callers should display it once prominently.
 */
export async function generateWebhookSecret(
  repoInput: string,
): Promise<{ secret: string; id: string; repo: string } | { error: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  const repo = normalizeRepo(repoInput);
  if (!repo) return { error: 'Invalid repo — expected the format "owner/name"' };

  const secret = randomHex64();

  // Deactivate only the prior active secret for this (user, repo) pair.
  await supabase
    .from('webhook_secrets')
    .update({ active: false })
    .eq('user_id', user.id)
    .eq('repo', repo)
    .eq('active', true);

  // Insert the new active row for this repo.
  const { data, error } = await supabase
    .from('webhook_secrets')
    .insert({ user_id: user.id, secret, repo, active: true })
    .select('id, created_at')
    .single();

  if (error) return { error: error.message };

  revalidatePath('/dashboard');
  return { secret, id: (data as { id: string }).id, repo };
}
