/**
 * Installation-sync endpoint — `POST /installations/sync`.
 *
 * The dashboard's GitHub App Setup-URL return bounce calls this with the
 * authenticated user's Supabase JWT so an installation becomes visible
 * immediately, WITHOUT depending on a webhook delivery or on GITHUB_APP_ENABLED.
 * This closes the gap where an App installed on GitHub never appeared in LoreKit
 * because the webhook path was dormant or a delivery was missed.
 *
 * Flow:
 *   1. Resolve the caller from their Supabase user JWT (never a caller-supplied
 *      user id).  api_key / service callers are rejected — this is a dashboard
 *      session action.
 *   2. Fetch the installation's account + repos from GitHub via an App JWT
 *      (github-app-client.ts — the only holder of the App private key).
 *   3. Entitlement: link the row to the caller ONLY when the installation's
 *      account is the caller's own GitHub account (lorekit_find_user_by_github_id
 *      resolves to their uid).  Otherwise the row is upserted as `pending`
 *      (user_id NULL) — the exact rule the webhook reconcile uses, so an org
 *      install can never be attributed to a user who doesn't own the account.
 *   4. Upsert via the SECURITY DEFINER lorekit_installation_upsert RPC.
 *
 * Never 5xx on an expected miss (app unconfigured, installation not found,
 * upsert error): returns 200 with `{ ok: false, error }` so the dashboard can
 * fall back to the webhook-driven path gracefully.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { traceRequest, type Span } from '../_shared/otel.ts';
import { resolveAuth } from './auth.ts';
import { isAppConfigured, fetchInstallation } from './github-app-client.ts';
import { reconcileInstallation } from './webhook-installation.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function processSync(req: Request, span: Span): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  const auth = await resolveAuth(req.headers.get('authorization'), null, span);
  if (!auth || auth.type !== 'user' || !auth.userId) {
    // Dashboard-only: a real Supabase user session is required so the linked
    // row is attributed to a verified identity, never a caller-supplied id.
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let payload: { installation_id?: unknown } = {};
  try {
    const parsed: unknown = await req.json();
    // A valid-JSON but non-object body (e.g. literal `null`, a number, a string)
    // must not crash the property read below into a 500 — coerce to {} so it
    // falls through to the clean `invalid_installation_id` 400.
    if (parsed && typeof parsed === 'object') payload = parsed as { installation_id?: unknown };
  } catch {
    return json({ ok: false, error: 'invalid_body' }, 400);
  }

  const installationId = Number(payload.installation_id);
  if (!Number.isFinite(installationId) || installationId <= 0) {
    return json({ ok: false, error: 'invalid_installation_id' }, 400);
  }

  span.setAttributes({
    'lorekit.installation.installation_id': installationId,
    'auth.user_id': auth.userId,
  });

  if (!isAppConfigured()) {
    span.setAttributes({ 'lorekit.installation.app_configured': false });
    return json({ ok: false, error: 'app_not_configured' }, 200);
  }

  const info = await fetchInstallation(installationId);
  if (!info) {
    span.setAttributes({ 'lorekit.installation.fetch_failed': true });
    return json({ ok: false, error: 'installation_not_found' }, 200);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Entitlement: only attribute the installation to this caller when its GitHub
  // account IS the caller's own account. Same rule as the webhook reconcile.
  const { data: matchedUserId } = await db.rpc('lorekit_find_user_by_github_id', {
    p_github_account_id: String(info.accountId),
  });
  const entitled = typeof matchedUserId === 'string' && matchedUserId === auth.userId;
  const verdict = reconcileInstallation(info.accountId, entitled ? { userId: auth.userId } : null);

  span.setAttributes({
    'lorekit.installation.verdict': verdict.kind,
    'lorekit.installation.account_login': info.accountLogin,
    'lorekit.installation.account_type': info.accountType,
    'lorekit.installation.repo_count': info.repos.length,
  });

  const { error: upsertError } = await db.rpc('lorekit_installation_upsert', {
    p_installation_id: installationId,
    p_github_account_id: info.accountId,
    p_github_account_login: info.accountLogin,
    p_account_type: info.accountType,
    p_user_id: verdict.kind === 'linked' ? verdict.userId : null,
    p_status: verdict.kind,
    p_repos: info.repos,
  });

  if (upsertError) {
    span.setAttributes({ 'lorekit.installation.upsert_error': upsertError.message });
    span.error(`InstallationUpsertError: ${upsertError.message}`);
    return json({ ok: false, error: 'upsert_failed' }, 200);
  }

  // Only a caller entitled to this installation may see its GitHub account
  // metadata.  `installation_id` is caller-supplied and `status` is needed by
  // the dashboard's audit branch, so both are always returned; the account
  // login, account type and repo count are withheld unless the row was linked
  // to THIS caller — otherwise any authenticated user could POST an arbitrary
  // installation_id and read back details of an install they do not own.
  return json(
    verdict.kind === 'linked'
      ? {
          ok: true,
          status: verdict.kind,
          installation_id: installationId,
          account_login: info.accountLogin,
          account_type: info.accountType,
          repositories: info.repos.length,
        }
      : { ok: true, status: verdict.kind, installation_id: installationId },
    200,
  );
}

export function handleInstallationSync(req: Request): Promise<Response> {
  return traceRequest(req, 'lorekit.installation.sync', (span) => processSync(req, span));
}
