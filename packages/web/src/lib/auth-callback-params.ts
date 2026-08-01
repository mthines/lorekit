/**
 * Pure classification of what a Supabase auth redirect actually delivered.
 *
 * Supabase hands a completed email action back to the app in one of three
 * shapes, and which one you get depends on project settings we do not control
 * from the code:
 *
 * 1. **PKCE** — `?code=…`. Exchanged server-side with `exchangeCodeForSession`.
 *    Only works in the browser that started the flow (the code verifier is
 *    stored there), so a link opened on a phone after signing up on a laptop
 *    fails.
 * 2. **Token hash** — `?token_hash=…&type=signup|recovery|…`. Verified
 *    server-side with `verifyOtp`. Browser-independent — this is the shape we
 *    prefer, and the one the email templates should use.
 * 3. **Implicit** — `#access_token=…&refresh_token=…`. The session is in the
 *    URL *fragment*, which is never sent to the server, so a route handler is
 *    structurally incapable of seeing it. Only a client component can pick it
 *    up (supabase-js does so automatically via `detectSessionInUrl`).
 *
 * A verification failure can also come back as `?error=…&error_code=…`, or as
 * the same keys in the fragment.
 *
 * These helpers are import-free so both the server route and the client
 * components can share one reading of the same URL.
 */

/** OTP types Supabase can send to an email redirect. */
export const EMAIL_OTP_TYPES = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
] as const;

export type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number];

export type AuthCallbackKind = 'code' | 'token_hash' | 'error' | 'none';

/**
 * Is this redirect a GitHub App Setup-URL return rather than a Supabase auth
 * redirect?
 *
 * GitHub bounces the user back to the App's Setup URL with
 * `?installation_id=…&setup_action=install` and — when the install also
 * completed GitHub's own OAuth — its own `?code=…`. That `code` is a GitHub
 * OAuth code; it is NOT a Supabase PKCE code and there is no Supabase code
 * verifier in this browser's storage to exchange it against. Handing it to
 * `exchangeCodeForSession` always fails with `pkce_code_verifier_not_found`.
 *
 * Both params are required: `setup_action` accompanies `installation_id` per
 * the GitHub App Setup-URL spec, and requiring the pair keeps a stray
 * `?installation_id=` on a genuine Supabase redirect from suppressing a real
 * exchange.
 */
export function isGithubAppSetupReturn(params: URLSearchParams): boolean {
  return !!params.get('installation_id') && !!params.get('setup_action');
}

/**
 * Discriminated on `kind` so consumers narrow to exactly the fields that shape
 * carries — no optional-field juggling and no non-null assertions at the call
 * site.
 */
export type AuthCallbackParams =
  | { kind: 'none' }
  | { kind: 'code'; code: string }
  | { kind: 'token_hash'; tokenHash: string; type: EmailOtpType }
  | { kind: 'error'; errorCode: string; errorDescription?: string };

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return !!value && (EMAIL_OTP_TYPES as readonly string[]).includes(value);
}

/**
 * Classify the query string of an auth redirect.
 *
 * Precedence is error → token_hash → code: an error is terminal regardless of
 * what else is present, and a `token_hash` is preferred over a `code` because
 * verifying it does not depend on this browser having started the flow.
 *
 * A `code` that arrives on a GitHub App Setup-URL return is deliberately NOT
 * classified as a PKCE code — see `isGithubAppSetupReturn`. It belongs to
 * GitHub, so there is nothing here for Supabase to exchange and the callback
 * has no session work to do.
 *
 * Total function — anything unrecognised is `{ kind: 'none' }`.
 */
export function classifyAuthCallback(params: URLSearchParams): AuthCallbackParams {
  const errorCode = params.get('error_code') ?? params.get('error');
  if (errorCode) {
    const description = params.get('error_description');
    return {
      kind: 'error',
      errorCode,
      ...(description ? { errorDescription: description } : {}),
    };
  }

  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  if (tokenHash && isEmailOtpType(type)) {
    return { kind: 'token_hash', tokenHash, type };
  }

  const code = params.get('code');
  if (code && !isGithubAppSetupReturn(params)) return { kind: 'code', code };

  return { kind: 'none' };
}

/**
 * Does this URL fragment carry an implicit-flow session (or an error)?
 *
 * Used by the client-side catchers to decide whether a page that Supabase
 * bounced the user to — possibly the Site URL, if the redirect target was not
 * on the project's allow-list — is actually mid-auth rather than a plain
 * visit. Accepts the raw `window.location.hash`, with or without the leading
 * `#`.
 */
export function fragmentCarriesAuthResult(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return false;
  const params = new URLSearchParams(raw);
  return (
    params.has('access_token') ||
    params.has('refresh_token') ||
    params.has('error') ||
    params.has('error_code')
  );
}
