/**
 * Pure model for changing the signed-in user's email address from
 * Settings → User.
 *
 * The change itself is Supabase Auth's own confirmation flow:
 * `supabase.auth.updateUser({ email }, { emailRedirectTo })` records the new
 * address as `user.new_email` and emails a confirmation link — to the new
 * address, and also to the current one when the project has "Secure email
 * change" on (Supabase's default, `double_confirm_changes`, which
 * `supabase/config.toml` leaves untouched). The address only changes once
 * every link is opened; the link lands on
 * `/api/auth/callback` (which already verifies `email_change`) and then back
 * on `/settings/user`. So this module only has to validate the input and
 * translate failures into copy — there is no LoreKit-side state to keep.
 *
 * Import-free apart from the shared auth-error mapping, so it stays
 * unit-testable in the node vitest environment.
 */

import { friendlyAuthError, type AuthErrorLike } from './auth-errors';

/** Where the confirmation link returns to after `/api/auth/callback` verifies it. */
export const EMAIL_CHANGE_RETURN_PATH = '/settings/user';

export type EmailChangeValidation = { ok: true; value: string } | { ok: false; error: string };

// Deliberately loose — one `@`, something on each side, a dot in the domain,
// no whitespace. Supabase Auth is the authority on what it will accept; this
// only catches typos before a round trip.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate the address the user wants to switch to.
 *
 * Returns the trimmed address, or a user-facing error. Total — never throws.
 */
export function validateEmailChange(
  raw: string,
  currentEmail: string | null | undefined,
): EmailChangeValidation {
  const value = raw.trim();
  if (!value) return { ok: false, error: 'Enter the email address you want to use.' };
  if (!EMAIL_SHAPE.test(value)) {
    return { ok: false, error: "That doesn't look like a valid email address." };
  }
  // Supabase stores addresses lowercased, so compare the same way.
  if (currentEmail && value.toLowerCase() === currentEmail.toLowerCase()) {
    return { ok: false, error: "That's already your email address." };
  }
  return { ok: true, value };
}

/**
 * Translate a failed `updateUser({ email })` call into copy for the settings
 * form.
 *
 * Differs from `friendlyAuthError` in two places, both because the sign-in
 * wording is wrong here rather than for any new policy:
 *
 * - **An address that belongs to another account is named as such.** Sign-up
 *   hides this to avoid an account-enumeration oracle, but that reasoning does
 *   not carry over: this caller is already authenticated and rate-limited, and
 *   Supabase's own `email_exists` response is visible to them in the browser's
 *   network panel whatever the copy says. Hiding it would only leave them
 *   waiting for an email that is never sent.
 * - **Rate limits and expired sessions talk about this action**, not about
 *   "sign-in attempts" or "requesting a new link".
 *
 * Everything else falls through to `friendlyAuthError`.
 */
export function friendlyEmailChangeError(error: AuthErrorLike): string {
  const msg = error.message.toLowerCase();
  const code = (error.code ?? '').toLowerCase();

  if (
    code === 'email_exists' ||
    code === 'user_already_exists' ||
    msg.includes('already been registered') ||
    msg.includes('already registered')
  ) {
    return 'That email address is already used by another LoreKit account.';
  }

  if (code === 'email_address_invalid' || code === 'email_address_not_authorized') {
    return "That email address can't be used. Try a different one.";
  }

  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    msg.includes('rate limit') ||
    error.status === 429
  ) {
    return 'Too many email change requests. Wait a few minutes and try again.';
  }

  if (code === 'session_not_found' || msg.includes('auth session missing')) {
    return 'Your session has expired. Sign in again, then retry the change.';
  }

  return friendlyAuthError(error);
}

/**
 * Copy for a confirmation link that came back as `?error=<code>` on
 * `/settings/user` — `/api/auth/callback` forwards both a Supabase-rejected
 * link and a failed code exchange that way.
 *
 * Only ever returns fixed copy chosen by the code; the raw query value is
 * never echoed into the page.
 */
export function friendlyEmailChangeLinkError(code: string): string {
  const normalized = code.toLowerCase();

  // A PKCE exchange fails when the link is opened in a different browser from
  // the one the change was requested in. Supabase has already confirmed the
  // address by the time it redirects (verification happens before the code is
  // handed out), so the change may well have gone through — only the
  // follow-up sign-in in this browser failed.
  if (
    normalized === 'flow_state_not_found' ||
    normalized === 'pkce_code_verifier_not_found' ||
    normalized === 'bad_code_verifier'
  ) {
    return 'That confirmation link was opened in a different browser. The change may still have gone through — the address shown above is your current one.';
  }

  if (normalized === 'otp_expired' || normalized === 'access_denied') {
    return 'That confirmation link has expired or was already used. Request the change again to get a new one.';
  }

  return "That confirmation link didn't work. Request the change again to get a new one.";
}
