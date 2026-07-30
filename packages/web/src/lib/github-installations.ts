'use server';

/**
 * Server actions for GitHub App installation state — read-only from the
 * dashboard's perspective.
 *
 * Mirrors the structure of lib/webhook-secrets.ts: createServerClient +
 * auth.getUser + RLS-scoped query + recordAuditEvent where appropriate +
 * revalidatePath on writes.
 *
 * Authorization: all queries run under the authenticated user's JWT.  RLS on
 * github_installations (00037) restricts rows to status='linked' rows where
 * user_id = auth.uid(), so a user can only ever read their own linked
 * installations.
 *
 * The GitHub App Setup-URL return bounce threads ?installation_id and ?state
 * through the auth/callback route — see handleSetupReturn below and
 * app/api/auth/callback/route.ts.
 */

import { createServerClient } from '@/lib/supabase/server';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';

export interface GithubInstallation {
  id: string;
  installation_id: number;
  github_account_id: number;
  github_account_login: string;
  account_type: 'User' | 'Organization';
  status: 'pending' | 'linked' | 'removed';
  created_at: string;
  updated_at: string;
  repositories: GithubInstallationRepository[];
}

export interface GithubInstallationRepository {
  id: string;
  full_name: string;
  active: boolean;
  added_at: string;
}

/**
 * List the current user's linked GitHub App installations, each with their
 * covered repositories.  Returns [] on auth failure or DB error.
 *
 * RLS: only rows with user_id = auth.uid() and status = 'linked' are visible.
 */
export async function listGithubInstallations(): Promise<GithubInstallation[]> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('github_installations')
    .select(`
      id,
      installation_id,
      github_account_id,
      github_account_login,
      account_type,
      status,
      created_at,
      updated_at,
      installation_repositories (
        id,
        full_name,
        active,
        added_at
      )
    `)
    .eq('status', 'linked')
    .order('created_at', { ascending: false });

  if (error) {
    // Non-fatal: surface an empty list rather than throwing, matching the
    // pattern in listWebhookSecrets.
    return [];
  }

  return ((data ?? []) as Array<Omit<GithubInstallation, 'repositories'> & {
    installation_repositories: GithubInstallationRepository[];
  }>).map((row) => ({
    ...row,
    repositories: (row.installation_repositories ?? []).filter((r) => r.active),
  }));
}

/**
 * Handle the GitHub App Setup-URL return bounce.
 *
 * When a user installs the GitHub App, GitHub redirects back to the Setup URL
 * with query params:
 *   ?installation_id=<id>&setup_action=install[&state=<state>]
 *
 * This action:
 *   1. Verifies the user is authenticated (RLS — no trust of caller-supplied ids).
 *   2. Associates the installation with the user's session if the installation
 *      is pending and the github_account_id matches their GitHub identity.
 *   3. Records an audit event.
 *
 * The `state` parameter is correlation-only — it never grants access.  Access
 * is always derived from the authenticated session (auth.uid() + RLS).
 *
 * Returns { ok: true } on success, { ok: false, error } on any failure.
 *
 * NOTE: In production the App must be registered and GITHUB_APP_ENABLED set.
 * Until then, installations arrive but stay pending until the next login.
 * This action gracefully handles the pending case (no-op when no matching
 * installation exists for the session user's GitHub account id).
 */
export async function handleSetupReturn(
  installationId: number,
  setupAction: string,
  state?: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  // Resolve the user's GitHub account id from their GitHub identity.
  // user.identities contains one entry per linked OAuth provider; look for the
  // github entry directly rather than checking app_metadata.providers (which
  // may be absent for single-provider GitHub-only users).
  const githubProviderData = user.identities?.find((identity) => identity.provider === 'github');

  if (!githubProviderData) {
    // The user hasn't signed in via GitHub — cannot auto-associate.
    // Log and return ok (no-op) so the dashboard still loads cleanly.
    return { ok: true };
  }

  const githubAccountId = Number(githubProviderData.id);
  if (!githubAccountId) return { ok: true };

  // Attempt to associate: update any pending installation for this account id
  // with the current user's id (transition pending → linked).
  // This is a service-role call because the pending row has user_id = NULL and
  // is therefore invisible via RLS (which requires user_id = auth.uid()).
  // We use a targeted update scoped to (installation_id, github_account_id)
  // so we cannot affect any other user's installation.
  const supabaseAdmin = createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['SUPABASE_SERVICE_ROLE_KEY']!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: pendingInstall, error: lookupError } = await supabaseAdmin
    .from('github_installations')
    .select('id, status')
    .eq('installation_id', installationId)
    .eq('github_account_id', githubAccountId)
    .maybeSingle();

  if (lookupError) {
    return { ok: false, error: lookupError.message };
  }

  if (!pendingInstall) {
    // Installation not found — it may arrive shortly via webhook delivery.
    // This is a safe no-op: the webhook reconcile will link it when it arrives.
    return { ok: true };
  }

  if (pendingInstall.status === 'linked') {
    // Already linked — idempotent no-op.
    return { ok: true };
  }

  // Transition to linked.
  const { error: updateError } = await supabaseAdmin
    .from('github_installations')
    .update({ user_id: user.id, status: 'linked', updated_at: new Date().toISOString() })
    .eq('id', pendingInstall.id)
    .eq('status', 'pending');

  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  await recordAuditEvent({
    action: 'github_app.installation_linked',
    resourceType: 'github_installation',
    resourceId: String(installationId),
    target: String(installationId),
    metadata: { setup_action: setupAction, state: state ?? null, github_account_id: githubAccountId },
  });

  revalidatePath('/settings', 'layout');
  return { ok: true };
}
