/**
 * Whether an authentication callback created an account or signed an existing
 * one back in.
 *
 * ## Why this cannot be decided in the browser
 *
 * `auth.intent` (`lib/auth-telemetry.ts`) records what the visitor was TRYING to
 * do, and for the two create-on-first-use paths — GitHub OAuth and magic link —
 * the honest answer is `login_or_signup`: the same button registers a new
 * visitor and signs in a returning one, and the page cannot know which before
 * the provider answers. Guessing there would be a fabricated number in the one
 * place the question actually matters.
 *
 * `/api/auth/callback` can know, because it holds the Supabase user record. This
 * is the seam where intent becomes outcome. Every path lands here and is
 * classified by the same rule — but see {@link AuthOutcome}: the rule can only
 * separate a signup from a sign-in on the OAuth path.
 *
 * ## How
 *
 * Supabase stamps `last_sign_in_at` on every sign-in, including the very first
 * one, which happens in the same transaction as the insert. So on a brand-new
 * account the two timestamps are effectively equal, and on a returning one
 * `created_at` is older by however long the visitor has had the account.
 *
 * That makes the classification a comparison against a tolerance rather than an
 * equality test — the two writes are not guaranteed to share a value to the
 * microsecond. {@link NEW_ACCOUNT_TOLERANCE_MS} is 10 seconds: comfortably wider
 * than any plausible write skew, and far narrower than any real gap between
 * signing up and coming back, so the two populations cannot overlap.
 *
 * Deliberately NOT inferred from `identities.length` or from the provider: a
 * returning visitor linking a second provider also gains an identity, and an
 * account can be created by any of the three paths.
 */

/**
 * How far apart `created_at` and `last_sign_in_at` may be while still counting
 * as the account's first sign-in.
 */
export const NEW_ACCOUNT_TOLERANCE_MS = 10_000;

/**
 * What the callback turned out to be.
 *
 * **`account_created` is only an acquisition signal on the OAuth path.** There,
 * the insert and the sign-in happen in the same callback. The two email paths
 * put a human round-trip in between — a magic link creates the account when it
 * is REQUESTED, and a confirmation link is opened minutes or hours after
 * `signUp` — so a first sign-in on either reports `returning_sign_in`. The
 * tolerance below absorbs write skew, not inboxes, and widening it to cover an
 * inbox would start swallowing genuine returning sign-ins.
 *
 * That is the limit of what two timestamps can prove, not a defect to work
 * around here. Count acquisition on those paths from the browser instead — the
 * `email_confirmation` success event, and `auth.intent` — as `docs/otel.md` §
 * "Signing up vs signing in" sets out per path.
 */
export type AuthOutcome = 'account_created' | 'returning_sign_in' | 'unknown';

/** The fields of the Supabase user record this reads. Both are optional there. */
export interface AuthOutcomeInput {
  createdAt?: string | null | undefined;
  lastSignInAt?: string | null | undefined;
}

/**
 * Classify a completed authentication.
 *
 * Total function: a missing, malformed or nonsensical pair yields `unknown`
 * rather than throwing or picking a side. `unknown` is a real answer here and
 * must stay countable — silently folding it into `returning_sign_in` would
 * understate signups by exactly the cases the data is least sure about.
 *
 * A `last_sign_in_at` BEFORE `created_at` is not merely tolerated as "close
 * enough": it is nonsensical, so it reports `unknown` rather than being read as
 * a small positive difference.
 */
export function classifyAuthOutcome({ createdAt, lastSignInAt }: AuthOutcomeInput): AuthOutcome {
  if (!createdAt || !lastSignInAt) return 'unknown';

  const created = Date.parse(createdAt);
  const signedIn = Date.parse(lastSignInAt);
  if (Number.isNaN(created) || Number.isNaN(signedIn)) return 'unknown';

  const elapsed = signedIn - created;
  if (elapsed < 0) return 'unknown';

  return elapsed <= NEW_ACCOUNT_TOLERANCE_MS ? 'account_created' : 'returning_sign_in';
}
