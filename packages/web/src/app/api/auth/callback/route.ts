import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { handleSetupReturn } from '@/lib/github-installations';
import { withSpan, logger, SpanKind, SpanStatusCode } from '@/lib/telemetry';

/**
 * Validate that a `?next=` redirect target is a safe relative path.
 *
 * Accepts paths that start with `/` but not `//` (scheme-relative URLs such as
 * `//evil.com` would be followed by browsers as an absolute URL and are an
 * open-redirect vector). Falls back to `/dashboard` for anything invalid.
 */
function safeNextPath(raw: string | null, fallback = '/dashboard'): string {
  if (!raw) return fallback;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return fallback;
}

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
  const next = safeNextPath(searchParams.get('next'));

  // GitHub App Setup-URL params (may coexist with the OAuth code).
  const rawInstallationId = searchParams.get('installation_id');
  const setupAction = searchParams.get('setup_action');
  const state = searchParams.get('state') ?? undefined;

  return withSpan(
    'lorekit.auth.callback',
    {
      'auth.callback.has_code': !!code,
      'auth.callback.has_installation_id': !!rawInstallationId,
      'auth.callback.next': next,
    },
    async (span) => {
      // 1. OAuth code exchange — always attempt first so the session is established
      //    before the GitHub App association below.
      if (code) {
        const supabase = await createServerClient();
        const { error, data } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
          span.setAttribute('auth.callback.outcome', 'success');
          span.setAttribute('auth.user_id', data.user?.id ?? 'unknown');
          span.setAttribute('auth.provider', data.user?.app_metadata?.['provider'] ?? 'unknown');
          logger.info('auth.callback.success', {
            'auth.provider': data.user?.app_metadata?.['provider'] ?? 'unknown',
          });
        } else {
          span.setAttribute('auth.callback.outcome', 'exchange_failed');
          span.setAttribute('auth.error_code', error.code ?? error.name);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          logger.warn('auth.callback.exchange_failed', {
            'auth.error_code': error.code ?? error.name,
            'error.message': error.message,
          });
          return NextResponse.redirect(`${origin}/login?error=auth_failed`);
        }
      }

      // 2. GitHub App Setup-URL: associate the installation with the session.
      //    Only proceed when installation_id is present and looks like a number.
      //    Note: setup_action is required alongside installation_id per the GitHub
      //    App Setup-URL spec.  If it is absent, we skip the association (the
      //    webhook reconcile will link the installation when the event arrives).
      if (rawInstallationId && setupAction) {
        const installationId = Number(rawInstallationId);
        if (Number.isFinite(installationId) && installationId > 0) {
          span.setAttribute('auth.callback.installation_id', installationId);
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

      span.setAttribute('auth.callback.outcome', 'no_code');
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'no auth code in callback' });
      logger.warn('auth.callback.no_code', {});
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    },
    SpanKind.SERVER,
  );
}
