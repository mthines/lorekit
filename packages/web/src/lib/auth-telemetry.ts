'use client';

import { sendEvent } from '@dash0/sdk-web';

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

/** Event names. Namespaced under `auth.` so they cannot collide with the SDK's own `browser.*`. */
export const AUTH_ATTEMPT_EVENT = 'auth.attempt';
export const AUTH_SUCCESS_EVENT = 'auth.success';
export const AUTH_FAILURE_EVENT = 'auth.failure';

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
type AuthEventOptions = NonNullable<Parameters<typeof sendEvent>[1]>;

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
  status?: number | undefined;
}

/**
 * The bounded code to report for a failed attempt.
 *
 * Supabase populates `code` for the errors that have a stable contract
 * (`invalid_credentials`, `email_not_confirmed`, …) and leaves it undefined for
 * transport-level ones, where `name` is the next most stable thing. The MESSAGE
 * is deliberately never used: it is prose, it is localised, and it can embed the
 * address that was typed — unbounded and PII-bearing, the two things a grouping
 * key must not be.
 *
 * Total function: any shape of input yields a usable string, because telemetry
 * must never be the reason an auth handler throws.
 */
export function authErrorCode(error: AuthErrorLike | null | undefined): string {
  if (!error) return 'unknown';
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
    attributes: { 'auth.method': method },
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
    attributes: { 'auth.method': method },
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
    attributes: { 'auth.method': method, 'auth.error_code': code },
  });
}
