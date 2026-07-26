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
import { recordAuditEvent } from '@/lib/audit-log';
import { resolveMcpUrls } from '@/lib/mcp-url';
import {
  VERIFY_EVENT,
  buildVerifyPayload,
  signBody,
  interpretVerifyStatus,
  type VerifyResult,
} from '@/lib/webhook-verify';

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

  // Deactivate only the prior active secret for this (user, repo) pair. The
  // deactivated row count (D10) distinguishes a rotate from a first-create —
  // the request-scoped `{ count: 'exact' }` option is required to read it.
  const { count: deactivatedCount } = await supabase
    .from('webhook_secrets')
    .update({ active: false }, { count: 'exact' })
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

  const id = (data as { id: string }).id;
  await recordAuditEvent({
    action: (deactivatedCount ?? 0) > 0 ? 'webhook_secret.rotate' : 'webhook_secret.create',
    resourceType: 'webhook_secret',
    resourceId: id,
    target: repo,
    metadata: { repo },
  });

  revalidatePath('/dashboard');
  // 'layout' so nested /settings/* pages (where secrets render) revalidate,
  // not just the /settings redirect page.
  revalidatePath('/settings', 'layout');
  return { secret, id, repo };
}

/**
 * Verify a repo's webhook is wired up correctly by sending a synthetic,
 * correctly-signed GitHub `ping` from the server to the live webhook endpoint
 * using the user's stored secret, then reporting whether it was accepted.
 *
 * This confirms LoreKit's half of the setup end-to-end: the endpoint is
 * deployed/reachable and the exact stored secret round-trips through the
 * deployed HMAC verification. `ping` is an unsupported event, so a valid
 * signature returns 200 OK without writing a candidate lesson — verification
 * never pollutes the lore. See lib/webhook-verify.ts for the boundary this
 * check does and does not prove.
 *
 * Legacy null-repo secrets can't be verified (there's no full_name to sign a
 * repo-scoped ping for) — callers should disable the button for those rows.
 */
export async function verifyWebhookSecret(repoInput: string): Promise<VerifyResult> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, code: 'unreachable', message: 'Not authenticated' };

  const repo = normalizeRepo(repoInput);
  if (!repo) {
    return { ok: false, code: 'unreachable', message: 'Invalid repo — expected the format "owner/name".' };
  }

  const { data, error } = await supabase
    .from('webhook_secrets')
    .select('secret')
    .eq('user_id', user.id)
    .eq('repo', repo)
    .eq('active', true)
    .maybeSingle();

  if (error || !data?.secret) {
    return { ok: false, code: 'no_secret', message: 'No active secret for this repo — generate one first.' };
  }

  const { webhookUrl } = resolveMcpUrls();
  const body = buildVerifyPayload(repo);
  const signature = await signBody(data.secret as string, body);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': VERIFY_EVENT,
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': signature,
      },
      body,
      // Never cache a verification probe — it must hit the live endpoint.
      cache: 'no-store',
    });
    return interpretVerifyStatus(res.status);
  } catch {
    return {
      ok: false,
      code: 'unreachable',
      message: 'Could not reach the webhook endpoint. Check that the MCP server is deployed.',
    };
  }
}

/**
 * Delete a webhook secret — implemented as a soft delete (deactivate). Setting
 * `active = false` drops the row from `listWebhookSecrets` (which filters
 * `active = true`) and from the edge function's lookup, so the secret stops
 * working immediately, while preserving the audit trail's foreign reference.
 * This matches the table's `active`-flag design (the partial unique index and
 * the `webhook_secret.deactivate` audit action both exist for this) and the
 * grace-window semantics already used by regeneration.
 *
 * Works for any row the user owns, including the legacy null-repo secret.
 */
export async function deleteWebhookSecret(id: string): Promise<{ error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Not authenticated' };

  // Read the repo before deactivating so the audit event has a readable target.
  const { data: existing } = await supabase
    .from('webhook_secrets')
    .select('repo')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  const { error } = await supabase
    .from('webhook_secrets')
    .update({ active: false })
    .eq('id', id)
    .eq('user_id', user.id) // Ensure ownership
    .eq('active', true);

  if (error) return { error: error.message };

  const repo = (existing?.repo as string | null) ?? null;
  await recordAuditEvent({
    action: 'webhook_secret.deactivate',
    resourceType: 'webhook_secret',
    resourceId: id,
    target: repo ?? 'legacy (all repos)',
    metadata: repo ? { repo } : {},
  });

  revalidatePath('/dashboard');
  revalidatePath('/settings', 'layout');
  return {};
}
