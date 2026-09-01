'use client';

import { sendEvent } from '@dash0/sdk-web';
import { isEmailSendFailure } from './auth-email-failure';

/**
 * Discrete telemetry for the authentication funnel.
 *
 * ## Why this module exists
 *
 * Every auth surface used to report itself with `addSignalAttribute`, e.g.
 * `addSignalAttribute('auth.method', 'github_oauth')` before the redirect and
 * `addSignalAttribute('auth.password_error_code', …)` on failure. That API does
 * what its name says — it adds an attribute to EVERY SIGNAL the SDK emits for
 * the rest of the page load — which is the wrong shape for a thing that happens
 * at one instant, and it broke the data in three separate ways:
 *
 * 1. **It labelled unrelated signals.** One click on "Continue with GitHub" put
 *    `auth.method=github_oauth` on 538 `browser.web_vital` events across 38
 *    sessions. Counting auth attempts meant counting web vitals, and every
 *    per-attribute breakdown of unrelated signals was skewed by it.
 * 2. **Stale values cross-contaminated later attempts.** The attributes are
 *    independent and nothing cleared them, so a visitor who failed a sign-in and
 *    then switched to "Create an account" emitted
 *    `auth.method=email_password_signup` alongside the PREVIOUS attempt's
 *    `auth.password_error_code=invalid_credentials`. That combination is not a
 *    thing the backend can return, and it read as a signup bug that did not
 *    exist.
 * 3. **Repeated calls accumulated.** `addSignalAttribute` appends rather than
 *    replaces (the same property `dash0-rum.ts` documents for `user.id`), so a
 *    visitor who retried twice shipped several entries for one key.
 *
 * The failure mode they share is that an attribute describes the SIGNAL it is
 * attached to, and none of those signals were the auth attempt. A discrete
 * `sendEvent` is a signal of its own, so the method, the outcome and the error
 * code sit on the one event they actually describe, and nothing else carries
 * them.
 *
 * ## What it buys
 *
 * The funnel becomes countable without inference: `auth.attempt` minus
 * `auth.success` is the drop-off, grouped by `auth.method`, and no query has to
 * guess which page view happened to inherit a label. That is what the previous
 * shape could not answer — "how many people tried to sign up" had to be
 * approximated from whichever signals happened to carry the attribute.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/general/events/
 */

/**
 * The authentication paths a visitor can take. Bounded on purpose: this becomes
 * a grouping key, so an unbounded value would fragment every aggregation.
 */
export type AuthMethod =
  | 'github_oauth'
  | 'email_password'
  | 'email_password_signup'
  | 'email_otp'
  | 'email_confirmation'
  | 'password_reset_request'
  | 'password_reset_complete'
  | 'password_change_settings';

/**
 * What the visitor is trying to do, as opposed to which mechanism they picked.
 *
 * `auth.method` alone cannot answer "are people signing up or signing in?" —
 * it takes a reader who knows that `email_password_signup` is registration and
 * `password_reset_complete` is not. This is that knowledge, encoded once.
 *
 * `login_or_signup` is not a hedge, it is the truth for the OAuth and magic-link
 * paths: both create an account when there is none and sign the visitor in when
 * there is, and the browser genuinely cannot tell which will happen before it
 * happens. Collapsing them into either bucket would be a guess presented as
 * fact. Which one it turned out to be is settled server-side by `auth.outcome`
 * (`lib/auth-outcome.ts`), on the one signal that can actually see the account.
 */
export type AuthIntent = 'login' | 'signup' | 'login_or_signup' | 'recovery' | 'account_management';

/** The intent each method serves. Total over `AuthMethod`, so a new method must choose. */
const INTENT_BY_METHOD: Record<AuthMethod, AuthIntent> = {
  // Both create-on-first-use. See `AuthIntent`.
  github_oauth: 'login_or_signup',
  email_otp: 'login_or_signup',

  email_password: 'login',
  email_password_signup: 'signup',
  // The last step of a signup that began with `email_password_signup`.
  email_confirmation: 'signup',

  password_reset_request: 'recovery',
  password_reset_complete: 'recovery',
  password_change_settings: 'account_management',
};

/** The intent a method serves. */
export function authIntent(method: AuthMethod): AuthIntent {
  return INTENT_BY_METHOD[method];
}

/** Event names. Namespaced under `auth.` so they cannot collide with the SDK's own `browser.*`. */
export const AUTH_ATTEMPT_EVENT = 'auth.attempt';
export const AUTH_SUCCESS_EVENT = 'auth.success';
export const AUTH_FAILURE_EVENT = 'auth.failure';
export const AUTH_OPTION_SELECTED_EVENT = 'auth.option_selected';
export const AUTH_PENDING_EVENT = 'auth.pending';

/** The SDK's own event options, derived from `sendEvent` so the two cannot drift. */
type AuthEventOptions = NonNullable<Parameters<typeof sendEvent>[1]>;

/**
 * Every emission goes through here, so this module's promise — telemetry is
 * never the reason an auth handler throws — holds by construction rather than
 * by whatever the SDK happens to do today.
 *
 * As of `@dash0/sdk-web` 0.23.0 there is no synchronous throw path to catch:
 * `vars` is fully defaulted at module load, the attribute builders
 * optional-chain every DOM read, and the transport is async with its own
 * internal `.catch`. That is a property of the pinned version, not of the
 * contract, and `analytics/track.ts` already pays the same three lines for the
 * same reason — so the guard is consistency and defence-in-depth, not a fix for
 * a reachable crash.
 */
function emit(name: string, options: AuthEventOptions): void {
  try {
    sendEvent(name, options);
  } catch {
    // Telemetry is best-effort; never let it break an auth flow.
  }
}

/** The shape of the Supabase auth errors this module is handed. */
interface AuthErrorLike {
  code?: string | undefined;
  name?: string | undefined;
  message?: string | undefined;
}

/**
 * The bounded code to report for a failed attempt.
 *
 * Supabase populates `code` for the errors that have a stable contract
 * (`invalid_credentials`, `email_not_confirmed`, …) and leaves it undefined for
 * transport-level ones, where `name` is the next most stable thing. The MESSAGE
 * itself is deliberately never reported verbatim: it is prose, it is localised,
 * and it can embed the address that was typed — unbounded and PII-bearing, the
 * two things a grouping key must not be.
 *
 * One exception: a broken mailer (bad SMTP credentials, a missing DNS record on
 * the sending domain, an unreachable relay) never gets a `code` from GoTrue, and
 * `name` is just the same generic `AuthApiError` every other server-side auth
 * failure carries — so without this check that entire failure class collapsed
 * into a bucket indistinguishable from any other API error, with no way to alert
 * on it specifically. `isEmailSendFailure` (`auth-email-failure.ts`) recognises
 * it from the message's stable "Error sending … email" prefix — the one part of
 * the message that is neither prose nor PII — and reports the bounded
 * `email_send_failed` instead.
 *
 * Total function: any shape of input yields a usable string, because telemetry
 * must never be the reason an auth handler throws.
 */
export function authErrorCode(error: AuthErrorLike | null | undefined): string {
  if (!error) return 'unknown';
  if (isEmailSendFailure(error.message)) return 'email_send_failed';
  return error.code ?? error.name ?? 'unknown';
}

/**
 * Record that a visitor started an authentication attempt.
 *
 * Emitted at the point of intent — before the network call, and before an OAuth
 * redirect navigates the page away — so a visitor who never comes back is still
 * counted as having tried. That is the whole population the funnel measures
 * against, and it is precisely the one an after-the-fact attribute could not
 * capture.
 */
export function reportAuthAttempt(method: AuthMethod): void {
  emit(AUTH_ATTEMPT_EVENT, {
    title: `Auth attempt: ${method}`,
    attributes: { 'auth.method': method, 'auth.intent': authIntent(method) },
  });
}

/**
 * Record that an attempt authenticated the visitor.
 *
 * Not emitted for the OAuth path: success there is a redirect to a new document,
 * so this page has already gone. Landing on the destination is the evidence.
 */
export function reportAuthSuccess(method: AuthMethod): void {
  emit(AUTH_SUCCESS_EVENT, {
    title: `Auth success: ${method}`,
    attributes: { 'auth.method': method, 'auth.intent': authIntent(method) },
  });
}

/**
 * Record that an attempt failed, with the bounded reason.
 *
 * Severity is `WARN`, not `ERROR`: a mistyped password is the system working as
 * designed, and grading it as an error would drown the genuine faults.
 */
export function reportAuthFailure(method: AuthMethod, error: AuthErrorLike | null | undefined): void {
  const code = authErrorCode(error);
  emit(AUTH_FAILURE_EVENT, {
    title: `Auth failure: ${method} (${code})`,
    severity: 'WARN',
    attributes: {
      'auth.method': method,
      'auth.intent': authIntent(method),
      'auth.error_code': code,
    },
  });
}

/**
 * Record that a visitor chose an authentication option — pressed "Continue with
 * GitHub", opened the email form, or asked for a magic link.
 *
 * This is the step the funnel was missing. Two of the three options on the login
 * page are pure local state changes: they swap a panel, make no network call,
 * and emitted nothing, so "how many people even tried the email route?" was not
 * a question the data could answer — a visitor who opened the form, read it and
 * left was indistinguishable from one who never touched it. Only submissions
 * were visible, which measures the bottom of the funnel and calls it the top.
 *
 * Distinct from {@link reportAuthAttempt}, and both are needed: selecting is
 * "showed interest in this route", attempting is "handed over credentials". The
 * gap between them is the form-abandonment rate.
 */
export function reportAuthOptionSelected(method: AuthMethod): void {
  emit(AUTH_OPTION_SELECTED_EVENT, {
    title: `Auth option selected: ${method}`,
    attributes: { 'auth.method': method, 'auth.intent': authIntent(method) },
  });
}

/**
 * Record that a signup reached the "check your inbox" screen with neither an
 * error nor a session — `email_password_signup`'s third branch
 * (`LoginButton.tsx`), taken when the project requires confirmation.
 *
 * ## Why this exists
 *
 * That branch is a genuine blind spot, and by design: Supabase returns the
 * exact same response — no error, no session — whether this is a brand-new
 * signup awaiting confirmation or a resubmission to an already-registered
 * address, so reporting `auth.success` there would overstate signups *and*
 * leak the distinction the screen exists to hide (see the comment at the call
 * site). The result is that this event, `reportAuthFailure` and
 * `reportAuthSuccess` are jointly exhaustive over the outcomes this document
 * can observe — but none of the three previously fired here, so a signup that
 * fully succeeded at the API layer and was then never delivered (a
 * misconfigured DNS record on the sending domain, an unreachable SMTP relay,
 * a silently-dropped async send) looked, in the browser's own telemetry,
 * identical to one that never happened at all.
 *
 * This event does not — cannot — prove the email was delivered; Supabase
 * never tells the browser that. What it proves is the one fact the browser
 * *can* attest to: the signup reached this state. Paired with the
 * `auth.success` events for `auth.method = email_confirmation`
 * (`WelcomeContent.tsx`, emitted when the link is actually opened), a
 * sustained gap between the two — many pending, few completions, over a
 * window wider than a normal inbox-checking delay — is the regression signal
 * for exactly the failure mode this event exists to catch, and the only one
 * this funnel can offer for it.
 */
export function reportAuthPending(method: AuthMethod): void {
  emit(AUTH_PENDING_EVENT, {
    title: `Auth pending: ${method}`,
    attributes: { 'auth.method': method, 'auth.intent': authIntent(method) },
  });
}
