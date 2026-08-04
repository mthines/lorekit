/**
 * OAuth error responses (RFC 6749 §5.2, §4.1.2.1).
 *
 * Pure builders — no NextResponse, no framework import — so the shapes are
 * unit-testable and identical whether they leave through a route handler, a
 * redirect, or a test assertion.
 *
 * The status mapping is fixed by the RFC and is NOT the place to be creative:
 * `invalid_client` is the only 401 (and only when the client authenticated),
 * everything else the token endpoint rejects is a 400. In particular
 * `invalid_grant` must be 400, not 401 — a 401 makes some clients discard the
 * session and restart discovery instead of surfacing the real problem.
 */

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable';

export interface OAuthErrorBody {
  error: OAuthErrorCode;
  error_description?: string;
}

/** HTTP status for a token/registration-endpoint error. */
export function oauthErrorStatus(code: OAuthErrorCode): number {
  if (code === 'invalid_client') return 401;
  if (code === 'server_error') return 500;
  if (code === 'temporarily_unavailable') return 503;
  return 400;
}

/** Build the JSON body for an OAuth error response. */
export function oauthErrorBody(code: OAuthErrorCode, description?: string): OAuthErrorBody {
  return description ? { error: code, error_description: description } : { error: code };
}

/**
 * Whether an authorize-endpoint error may be reported by redirecting back to
 * the client, or must be rendered to the user instead.
 *
 * RFC 6749 §4.1.2.1 draws the line at the redirect target, NOT at the error
 * code: once the `redirect_uri` has been validated against a registered
 * client, every error is reported by redirecting (that is how the client
 * learns the request failed). Before that — an unknown `client_id`, a missing
 * or unregistered `redirect_uri` — redirecting would turn the endpoint into an
 * open redirector that also hands the error to an attacker-chosen
 * destination, so the error must be rendered in the browser.
 */
export function canRedirectError(redirectUriValidated: boolean): boolean {
  return redirectUriValidated;
}
