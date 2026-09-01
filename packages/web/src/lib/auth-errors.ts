/**
 * Pure Supabase-auth error → user-facing message mapping.
 *
 * Supabase returns terse internal messages (e.g. "Invalid login credentials",
 * "Email rate limit exceeded") that are not suitable to show directly. This is
 * the single source of truth for translating them, shared by every auth
 * surface — the login form (magic link *and* password), the forgot-password
 * page, the update-password page, and the settings password panel — so the
 * same failure never reads differently in two places.
 *
 * Falls back to the raw message (capitalised) for anything unrecognised, which
 * is still better than silence.
 */

import { MIN_PASSWORD_LENGTH } from './password-policy';
import { isEmailSendFailure } from './auth-email-failure';

/**
 * Structural subset of `@supabase/supabase-js`'s `AuthError` this module
 * needs. Declared structurally so the mapping stays pure and testable without
 * constructing a real `AuthError`.
 */
export interface AuthErrorLike {
  message: string;
  code?: string | undefined;
  status?: number | undefined;
  name?: string | undefined;
}

export function friendlyAuthError(error: AuthErrorLike): string {
  const msg = error.message.toLowerCase();
  const code = (error.code ?? '').toLowerCase();

  // -- Password sign-in ----------------------------------------------------
  // Deliberately does NOT distinguish "no such account" from "wrong password"
  // — that distinction is an account-enumeration oracle.
  if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) {
    return 'Incorrect email or password. If you signed up with GitHub or a magic link, use that instead — or reset your password to set one.';
  }

  // Account exists but the email was never confirmed.
  if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) {
    return 'Please confirm your email first — check your inbox for the confirmation link.';
  }

  // -- Sign-up -------------------------------------------------------------
  // Deliberately does NOT confirm that the address is already registered.
  // With email confirmations off, Supabase surfaces `user_already_exists`
  // here, so an explicit "that account exists" message would turn sign-up
  // into an enumeration oracle — exactly what the invalid-credentials branch
  // above avoids. The copy mirrors the confirmation screen the happy path
  // shows, plus a generic recovery path so a returning user is not left
  // waiting on an email that will never arrive.
  if (
    code === 'user_already_exists' ||
    msg.includes('user already registered') ||
    msg.includes('already been registered')
  ) {
    return 'Check your inbox to finish setting up your account. If you already have one, sign in or reset your password instead.';
  }

  // -- Password policy -----------------------------------------------------
  if (code === 'weak_password' || msg.includes('password should be at least')) {
    return `That password is too weak. Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (code === 'same_password' || msg.includes('should be different from the old password')) {
    return 'Your new password must be different from your current one.';
  }

  // -- Session / recovery-link problems ------------------------------------
  if (
    code === 'otp_expired' ||
    msg.includes('token has expired') ||
    msg.includes('invalid or has expired')
  ) {
    return 'That link has expired or was already used. Request a new one and try again.';
  }
  if (code === 'session_not_found' || msg.includes('auth session missing')) {
    return 'Your session has expired. Request a new link and try again.';
  }
  // A PKCE exchange fails this way when the email link is opened in a
  // different browser from the one that started the flow — routine, and the
  // account is still confirmed, so the copy points at signing in rather than
  // implying something broke.
  if (code === 'flow_state_not_found' || msg.includes('code verifier')) {
    return 'This link was opened in a different browser from the one you started in. Sign in with your email and password to continue.';
  }
  if (code === 'access_denied' || code === 'auth_failed') {
    return "That link didn't work — it may have expired or already been used. Request a new one and try again.";
  }

  // -- Rate limiting — most common on Supabase Free tier (4 emails/hour) ---
  if (msg.includes('rate limit') || msg.includes('too many') || error.status === 429) {
    return 'Too many sign-in attempts. Please wait a few minutes and try again.';
  }

  // -- Invalid / undeliverable address -------------------------------------
  if (
    msg.includes('invalid email') ||
    msg.includes('unable to validate') ||
    code === 'validation_failed'
  ) {
    return "That doesn't look like a valid email address. Please double-check and try again.";
  }

  // -- Signups disabled in this Supabase project ---------------------------
  if (
    msg.includes('signups not allowed') ||
    msg.includes('signup is disabled') ||
    code === 'signup_disabled'
  ) {
    return 'Sign-up is currently disabled. Please contact the administrator.';
  }

  // -- Email provider rejected delivery, or the mailer itself is broken -----
  // (bounced, no such domain, unreachable SMTP relay, DNS lookup failure, ...)
  if (isEmailSendFailure(msg)) {
    return "We couldn't deliver an email to that address. Please check the address and try again.";
  }

  return error.message.charAt(0).toUpperCase() + error.message.slice(1);
}
