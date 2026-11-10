/**
 * Pure model for changing the signed-in user's email address from
 * Settings → User.
 *
 * The change itself is Supabase Auth's own confirmation flow:
 * `supabase.auth.updateUser({ email }, { emailRedirectTo })` records the new
 * address as `user.new_email` and emails a confirmation link — to the new
 * address, and also to the current one when the project has "Secure email
 * change" on AND "Confirm email" on (GoTrue skips the second confirmation when
 * email auto-confirm is enabled). The address only changes once every link is
 * opened. Each link goes through `/api/auth/callback` (which already verifies
 * `email_change`) and returns to {@link EMAIL_CHANGE_RETURN_PATH}. So this
 * module only validates input, classifies the result, and translates failures
 * into copy — there is no LoreKit-side state to keep.
 *
 * Import-free apart from the shared auth-error mapping, so it stays
 * unit-testable in the node vitest environment.
 */

import { friendlySettingsUpdateError, type AuthErrorLike } from './auth-errors';

/** The settings page the email form lives on. */
export const EMAIL_CHANGE_PAGE_PATH = '/settings/user';

/**
 * Query flag the confirmation link returns with, so the page can tell "I just
 * came back from a link" from a plain visit. The callback keeps `next`'s query
 * string and appends `error=<code>` to it when the link failed.
 */
export const EMAIL_CHANGE_RETURN_PARAM = 'email_change';

/** The `next` path handed to `/api/auth/callback` for an email change. */
export const EMAIL_CHANGE_RETURN_PATH = `${EMAIL_CHANGE_PAGE_PATH}?${EMAIL_CHANGE_RETURN_PARAM}=1`;

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

/** Structural subset of the `User` Supabase returns from `updateUser`. */
export interface EmailChangeUser {
  email?: string | undefined;
  new_email?: string | undefined;
}

export type EmailChangeOutcome = { kind: 'applied' } | { kind: 'pending'; pendingEmail: string };

/**
 * What a successful `updateUser({ email })` call did.
 *
 * Normally `pending`: the address waits in `new_email` until confirmed.
 * Current GoTrue only applies an email change immediately for anonymous users,
 * which LoreKit does not have, so `applied` is defensive — it keeps the form
 * from claiming a change is pending when the returned user says it is done.
 */
export function emailChangeOutcome(
  returnedUser: EmailChangeUser | null | undefined,
  requested: string,
): EmailChangeOutcome {
  if (returnedUser?.email && returnedUser.email.toLowerCase() === requested.toLowerCase()) {
    return { kind: 'applied' };
  }
  // `||`, not `??`: an empty `new_email` means nothing is pending.
  return { kind: 'pending', pendingEmail: returnedUser?.new_email || requested };
}

/**
 * Translate a failed `updateUser({ email })` call into copy for the settings
 * form.
 *
 * An address that belongs to another account is named as such. Sign-up hides
 * this to avoid an account-enumeration oracle, but that reasoning does not
 * carry over: this caller is already authenticated and rate-limited, and
 * Supabase's own `email_exists` response is visible to them in the browser's
 * network panel whatever the copy says. Hiding it would only leave them
 * waiting for an email that is never sent.
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

  if (code === 'over_email_send_rate_limit') {
    return 'Too many email change requests. Wait a few minutes and try again.';
  }

  return friendlySettingsUpdateError(error);
}

/**
 * Did Supabase itself reject the link (expired, reused, or superseded)? Then
 * nothing changed. Every other `?error=` code comes from the code exchange
 * AFTER Supabase verified the change — see {@link friendlyEmailChangeLinkError}.
 */
export function isRejectedLink(code: string): boolean {
  const normalized = code.toLowerCase();
  return normalized === 'otp_expired' || normalized === 'access_denied';
}

/**
 * Copy for a confirmation link that came back with `?error=<code>`.
 *
 * Two different failures arrive this way, and they mean opposite things:
 *
 * - **Supabase rejected the link** (`otp_expired`, `access_denied`): nothing
 *   changed, so the user should request the change again.
 * - **The code exchange after it failed** (`flow_state_expired` — the PKCE
 *   flow state lives 5 minutes from the request, so any link opened later hits
 *   it — `flow_state_not_found`, `pkce_code_verifier_not_found` for a link
 *   opened in another browser, and anything else): Supabase verifies the
 *   change BEFORE it hands out the code, so the address has most likely
 *   changed already and only the follow-up sign-in in this browser failed.
 *   Telling the user it "didn't work" would send them to retry a change that
 *   is done.
 *
 * Only ever returns fixed copy chosen by the code; the raw query value is
 * never echoed into the page.
 */
export function friendlyEmailChangeLinkError(code: string): string {
  if (isRejectedLink(code)) {
    return 'That confirmation link has expired or was already used. Request the change again to get a new one.';
  }
  return "We couldn't finish that link in this browser, but the change may already have gone through. Check the address shown above — if it hasn't changed, request the change again.";
}

export type EmailChangeReturnNotice = { tone: 'error' | 'info' | 'success'; message: string };

/**
 * What to tell a user who just came back from a confirmation link, or `null`
 * for a plain visit.
 *
 * Read from the user's own state rather than from the link: with secure email
 * change on, the first link leaves `new_email` set (one more to open) and the
 * last one clears it (done). Requires the return flag, so a hand-typed
 * `/settings/user?error=…` shows nothing.
 */
export function emailChangeReturnNotice(input: {
  returned: boolean;
  linkError: string | null;
  pendingEmail: string | null;
  currentEmail: string | null;
}): EmailChangeReturnNotice | null {
  if (!input.returned) return null;
  // A failed code exchange with nothing pending is a finished change: Supabase
  // applied it before handing out the code (e.g. a link opened after the
  // 5-minute flow window). Only a rejection, or a still-pending change, errors.
  if (input.linkError && (isRejectedLink(input.linkError) || input.pendingEmail)) {
    return { tone: 'error', message: friendlyEmailChangeLinkError(input.linkError) };
  }
  if (input.pendingEmail) {
    return {
      tone: 'info',
      message: 'Link confirmed. To finish, open the confirmation link sent to your other address.',
    };
  }
  return {
    tone: 'success',
    message: input.currentEmail
      ? `Your email address is now ${input.currentEmail}.`
      : 'Your email address has been updated.',
  };
}
