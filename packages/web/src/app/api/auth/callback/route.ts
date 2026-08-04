import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase/server';
import { handleSetupReturn } from '@/lib/github-installations';
import { withSpan, logger, SpanKind, SpanStatusCode } from '@/lib/telemetry';
// `safeNextPath` is shared with the client-side password sign-in so both
// redirect paths enforce the exact same same-origin rule.
import { safeNextPath } from '@/lib/auth-redirect';
import { classifyAuthOutcome } from '@/lib/auth-outcome';
import { classifyAuthCallback, isGithubAppSetupReturn } from '@/lib/auth-callback-params';

/**
 * Auth callback route — handles three flows:
 *
 * 1. Supabase session establishment, in whichever shape the project is
 *    configured to send (see `classifyAuthCallback`):
 *      - `?code=…`                   → `exchangeCodeForSession` (PKCE)
 *      - `?token_hash=…&type=…`      → `verifyOtp` (browser-independent, so an
 *                                      email link opened on another device still
 *                                      works — the preferred template shape)
 *      - `?error=…`                  → forwarded to the destination as a
 *                                      readable reason rather than swallowed
 *    The implicit flow (`#access_token=…`) is deliberately NOT handled here: a
 *    fragment is never sent to the server. `AuthHashCatcher` on the client
 *    picks that one up.
 *
 * 2. GitHub App Setup-URL return bounce (?installation_id=…&setup_action=…
 *    [&state=…][&code=…]): if an `installation_id` is present, attempts to
 *    associate the pending installation with the authenticated session.
 *    The `state` parameter is correlation-only — it never grants access.
 *    Access is always derived from auth.uid() + RLS.
 *
 * 3. Neither: a bare hit. Sent on to `next` rather than to an error, because
 *    the destination can still resolve an implicit-flow fragment client-side.
 *
 * Flows 1 and 2 can arrive together: GitHub sends both `code` (OAuth) and
 * `installation_id` when the user installs the App for the first time while
 * also completing OAuth. That `code` is GitHub's, not Supabase's, so
 * `classifyAuthCallback` reports `none` for it (see `isGithubAppSetupReturn`)
 * and this route goes straight to the installation association using the
 * session the user already has in this browser.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const next = safeNextPath(searchParams.get('next'));
  const callback = classifyAuthCallback(searchParams);

  // GitHub App Setup-URL params (may coexist with the auth params).
  const rawInstallationId = searchParams.get('installation_id');
  const setupAction = searchParams.get('setup_action');
  const state = searchParams.get('state') ?? undefined;

  return withSpan(
    'lorekit.auth.callback',
    {
      'auth.callback.kind': callback.kind,
      'auth.callback.otp_type': callback.kind === 'token_hash' ? callback.type : 'none',
      'auth.callback.has_installation_id': !!rawInstallationId,
      'auth.callback.github_setup': isGithubAppSetupReturn(searchParams),
      'auth.callback.next': next,
    },
    async (span) => {
      // 1. Establish the session, when this redirect actually carries Supabase
      //    auth params. A GitHub App Setup-URL return does not — its `code` is
      //    GitHub's, so `classifyAuthCallback` reports `none` for it (see
      //    `isGithubAppSetupReturn`) and it falls straight through to the
      //    association below, on the session the browser already has.
      let sessionEstablished = false;

      if (callback.kind === 'error') {
        // Supabase already rejected the link (expired, reused, wrong project).
        // Hand the reason to the destination page so it can say which.
        span.setAttribute('auth.callback.outcome', 'provider_error');
        span.setAttribute('auth.error_code', callback.errorCode);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: callback.errorDescription ?? callback.errorCode,
        });
        logger.warn('auth.callback.provider_error', {
          'auth.error_code': callback.errorCode,
        });
        const target = new URL(next, origin);
        target.searchParams.set('error', callback.errorCode);
        return NextResponse.redirect(target);
      }

      if (callback.kind === 'code' || callback.kind === 'token_hash') {
        const supabase = await createServerClient();
        const { data, error } =
          callback.kind === 'code'
            ? await supabase.auth.exchangeCodeForSession(callback.code)
            : await supabase.auth.verifyOtp({
                token_hash: callback.tokenHash,
                type: callback.type,
              });

        if (!error) {
          sessionEstablished = true;
          // Signup or sign-in? The browser cannot tell — GitHub OAuth and magic
          // links both create an account when there is none — so the funnel's
          // client-side events report `login_or_signup` for those paths and
          // leave the answer to here, the one place holding the user record.
          const accountOutcome = classifyAuthOutcome({
            createdAt: data.user?.created_at,
            lastSignInAt: data.user?.last_sign_in_at,
          });
          span.setAttribute('auth.callback.outcome', 'success');
          span.setAttribute('auth.outcome', accountOutcome);
          span.setAttribute('auth.user_id', data.user?.id ?? 'unknown');
          span.setAttribute('auth.provider', data.user?.app_metadata?.['provider'] ?? 'unknown');
          logger.info('auth.callback.success', {
            'auth.callback.kind': callback.kind,
            'auth.outcome': accountOutcome,
            'auth.provider': data.user?.app_metadata?.['provider'] ?? 'unknown',
          });
        } else {
          span.setAttribute('auth.callback.outcome', 'exchange_failed');
          span.setAttribute('auth.error_code', error.code ?? error.name);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          logger.warn('auth.callback.exchange_failed', {
            'auth.callback.kind': callback.kind,
            'auth.error_code': error.code ?? error.name,
            'error.message': error.message,
          });
          // A PKCE exchange fails when the link is opened in a different
          // browser from the one that started the flow — a routine situation
          // (sign up on a laptop, tap the link on a phone), not a broken app.
          // The destination still gets the reason and can say so plainly.
          const target = new URL(next, origin);
          target.searchParams.set('error', error.code ?? 'auth_failed');
          return NextResponse.redirect(target);
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
          if (!sessionEstablished) {
            // Distinguishes "GitHub bounced the user back here" from the
            // `no_auth_params` bare hit below, which it would otherwise be
            // indistinguishable from in telemetry.
            span.setAttribute('auth.callback.outcome', 'github_setup');
          }
          // handleSetupReturn is safe to call even if the user is not yet linked
          // (pending installs stay pending until a matching identity is found).
          // Errors here are non-fatal — we still redirect to the settings page.
          await handleSetupReturn(installationId, setupAction, state).catch(() => {
            // Non-fatal: the webhook delivery will reconcile the installation later.
          });

          // Redirect to the webhooks settings page so the user can see the result.
          return NextResponse.redirect(`${origin}/settings/integrations`);
        }
      }

      if (!sessionEstablished) {
        // No auth params at all. Historically this redirected to
        // /login?error=auth_failed, which was wrong for the implicit flow: the
        // session is sitting in a fragment the server cannot read, and the
        // destination page resolves it client-side. Send them on and let the
        // page decide.
        span.setAttribute('auth.callback.outcome', 'no_auth_params');
        logger.info('auth.callback.no_auth_params', { 'auth.callback.next': next });
      }

      return NextResponse.redirect(`${origin}${next}`);
    },
    SpanKind.SERVER,
  );
}
