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
import { createAdminClient, SupabaseAdminConfigError } from '@/lib/supabase/admin';
import { revalidatePath } from 'next/cache';
import { recordAuditEvent } from '@/lib/audit-log';
import { resolveMcpUrls } from '@/lib/mcp-url';

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
 * This action records the installation immediately, so it appears in the
 * dashboard WITHOUT waiting on a webhook delivery or on GITHUB_APP_ENABLED:
 *   1. Verifies the user is authenticated (no trust of caller-supplied ids).
 *   2. Calls the edge `installations/sync` endpoint with the user's JWT. That
 *      endpoint resolves the installation's account + repos via the App private
 *      key (a Supabase secret — never exposed to this Next.js runtime), applies
 *      the same own-account entitlement rule the webhook reconcile uses, and
 *      upserts the row.
 *   3. Records an audit event when the row is linked to the caller.
 *
 * If the sync does not succeed for any reason — App credentials not
 * provisioned (`app_not_configured`), installation not found, upsert error, or
 * the endpoint unreachable — it falls back to the webhook-driven linking path
 * (`linkPendingInstallation`), so behaviour is never worse than before.
 *
 * The `state` parameter is correlation-only — it never grants access. Access is
 * always derived from the authenticated session (auth.uid() + RLS).
 *
 * Returns { ok: true } on success, { ok: false, error } on any failure.
 */
export async function handleSetupReturn(
  installationId: number,
  setupAction: string,
  state?: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'not_authenticated' };

  // Forward the caller's session JWT to the edge endpoint so authorization is
  // server-derived from a verified identity, never a caller-supplied id.
  const { data: { session } } = await supabase.auth.getSession();
  const accessToken = session?.access_token;

  if (accessToken) {
    const { mcpUrl } = resolveMcpUrls();
    try {
      const res = await fetch(`${mcpUrl}/installations/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ installation_id: installationId }),
        cache: 'no-store',
      });
      const result = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        account_login?: string;
        error?: string;
      };

      if (res.ok && result.ok) {
        if (result.status === 'linked') {
          await recordAuditEvent({
            action: 'github_app.installation_linked',
            resourceType: 'github_installation',
            resourceId: String(installationId),
            target: String(installationId),
            metadata: {
              setup_action: setupAction,
              state: state ?? null,
              account_login: result.account_login ?? null,
            },
          });
        }
        revalidatePath('/settings', 'layout');
        return { ok: true };
      }

      // Fall through to the webhook-driven fallback on ANY non-ok sync, not
      // only `app_not_configured`.  The sole caller
      // (app/api/auth/callback/route.ts) awaits this inside a `.catch()` and
      // discards the returned object, so an early return here surfaced the
      // error to nobody and cost us the fallback.  linkPendingInstallation is
      // idempotent and scoped to the caller's own GitHub account id, so
      // retrying through it is safe on every unsuccessful sync result.
    } catch {
      // Endpoint unreachable — fall through to the webhook-driven fallback.
    }
  }

  return linkPendingInstallation(user, installationId, setupAction, state);
}

/**
 * Fallback linker for when the sync endpoint's App credentials are absent.
 *
 * Links a pending installation row that a webhook delivery already created,
 * scoped to the caller's own GitHub account id. This is the pre-sync-endpoint
 * behaviour, retained so a deployment with a live webhook but no App API key
 * still links installations. A no-op when no matching pending row exists.
 */
async function linkPendingInstallation(
  user: { id: string; identities?: Array<{ provider: string; id: string }> },
  installationId: number,
  setupAction: string,
  state?: string,
): Promise<{ ok: boolean; error?: string }> {
  // Resolve the user's GitHub account id from their GitHub identity.
  const githubProviderData = user.identities?.find((identity) => identity.provider === 'github');
  if (!githubProviderData) return { ok: true };

  const githubAccountId = Number(githubProviderData.id);
  if (!githubAccountId) return { ok: true };

  // Service-role call: the pending row has user_id = NULL and is invisible via
  // RLS. Scoped to (installation_id, github_account_id) so it cannot affect any
  // other user's installation.
  let supabaseAdmin;
  try {
    supabaseAdmin = createAdminClient();
  } catch (error) {
    if (error instanceof SupabaseAdminConfigError) {
      return { ok: false, error: error.code };
    }
    throw error;
  }

  const { data: pendingInstall, error: lookupError } = await supabaseAdmin
    .from('github_installations')
    .select('id, status')
    .eq('installation_id', installationId)
    .eq('github_account_id', githubAccountId)
    .maybeSingle();

  if (lookupError) return { ok: false, error: lookupError.message };
  if (!pendingInstall) return { ok: true };
  if (pendingInstall.status === 'linked') return { ok: true };

  const { error: updateError } = await supabaseAdmin
    .from('github_installations')
    .update({ user_id: user.id, status: 'linked', updated_at: new Date().toISOString() })
    .eq('id', pendingInstall.id)
    .eq('status', 'pending');

  if (updateError) return { ok: false, error: updateError.message };

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
