import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { handleSetupReturn } from '@/lib/github-installations';

/**
 * Auth callback route — handles two flows:
 *
 * 1. Supabase OAuth code exchange (?code=…): exchanges the code for a session
 *    and redirects to `next` (default: /dashboard).
 *
 * 2. GitHub App Setup-URL return bounce (?installation_id=…&setup_action=…
 *    [&state=…][&code=…]): if an `installation_id` is present, attempts to
 *    associate the pending installation with the authenticated session.
 *    The `state` parameter is correlation-only — it never grants access.
 *    Access is always derived from auth.uid() + RLS.
 *
 * The two flows can arrive together: GitHub sends both `code` (OAuth) and
 * `installation_id` when the user installs the App for the first time while
 * also completing OAuth.  We handle code-exchange first so the session exists
 * when we call handleSetupReturn.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  // GitHub App Setup-URL params (may coexist with the OAuth code).
  const rawInstallationId = searchParams.get('installation_id');
  const setupAction = searchParams.get('setup_action');
  const state = searchParams.get('state') ?? undefined;

  // 1. OAuth code exchange — always attempt first so the session is established
  //    before the GitHub App association below.
  if (code) {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }
  }

  // 2. GitHub App Setup-URL: associate the installation with the session.
  //    Only proceed when installation_id is present and looks like a number.
  if (rawInstallationId && setupAction) {
    const installationId = Number(rawInstallationId);
    if (Number.isFinite(installationId) && installationId > 0) {
      // handleSetupReturn is safe to call even if the user is not yet linked
      // (pending installs stay pending until a matching identity is found).
      // Errors here are non-fatal — we still redirect to the settings page.
      await handleSetupReturn(installationId, setupAction, state).catch(() => {
        // Non-fatal: the webhook delivery will reconcile the installation later.
      });

      // Redirect to the webhooks settings page so the user can see the result.
      return NextResponse.redirect(`${origin}/settings/webhooks`);
    }
  }

  // Standard OAuth redirect (or fallback when no installation_id present).
  if (code) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
