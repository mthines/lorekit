/**
 * The time window behind `GET /memories?expiring_within_days=N` — "lore that is
 * about to expire".
 *
 * Self-contained Deno mirror of `packages/mcp-core/src/limits/expiring-window.ts` — the
 * edge tree cannot cross-import the Node package. `edge-parity.spec.ts` compares
 * the two with comments stripped, so this file is free to say something
 * different here but must stay behaviourally identical below.
 *
 * The boundary semantics are the whole feature: an off-by-one does not throw, it
 * quietly shows the user a row that already expired or hides one that expires
 * tonight.
 */

/**
 * Bounds on `expiring_within_days`.
 *
 * The floor is 1 rather than 0 because a zero-day window is `(now, now]` — the
 * empty set — and an API parameter whose only effect is "return nothing" is a
 * trap, not a feature. The ceiling is 365 because the parameter exists to
 * surface an ACTIONABLE horizon; a two-year window is a way of asking "which
 * memories have a TTL at all", which is a different question and one the
 * unfiltered list already answers.
 */
export const EXPIRING_WITHIN_DAYS_MIN = 1;
export const EXPIRING_WITHIN_DAYS_MAX = 365;

const DAY_MS = 86_400_000;

/**
 * The half-open-at-the-bottom window `(after, onOrBefore]`, as ISO timestamps
 * ready to hand to PostgREST.
 */
export interface ExpiringWindow {
  /** EXCLUSIVE lower bound — `expires_at` must be strictly greater. */
  after: string;
  /** INCLUSIVE upper bound — `expires_at` must be less than or equal. */
  onOrBefore: string;
}

/**
 * Build the `(now, now + days]` window for the expiring-soon filter.
 *
 * **The asymmetry is deliberate, and it is the opposite of this codebase's
 * usual `[since, until)`.** Both ends are chosen by what the row means rather
 * than by convention:
 *
 * - The lower bound is EXCLUSIVE because it is not a window edge at all — it is
 *   the definition of "live". Every read path in the system spells an unexpired
 *   row `expires_at > now()` (the list handler's own live branch,
 *   `lorekit_purge_all_expired_memories`'s complement), so a row at exactly
 *   `now` is already gone. Making this inclusive would surface rows the very
 *   next request would refuse to return — AC-2.
 * - The upper bound is INCLUSIVE because "expiring within 7 days" plainly
 *   includes something expiring at the 7-day mark. An exclusive upper would put
 *   that row in the 8-day window and not the 7-day one, which reads as a bug to
 *   everyone who is not holding this file open.
 *
 * `NULL` needs no clause: `null > x` and `null <= x` are both SQL `NULL`, so a
 * memory with no TTL fails the comparison and drops out on its own (AC-3). The
 * filter is therefore two predicates, not three, and the "is not null" that
 * would look reassuring here would be dead weight the planner has to carry.
 *
 * Fails LOUD on bad input rather than degrading to a wider window. This is a
 * caller-supplied FILTER, the same call the read-activity `?scope=` filter
 * makes: silently coercing a malformed bound into "everything" answers a
 * different question than the one asked. The schema rejects out-of-range values
 * before a request reaches this, so a throw here means a programming error, not
 * user input.
 */
export function expiringWindow(days: number, nowIso: string): ExpiringWindow {
  if (!Number.isInteger(days) || days < EXPIRING_WITHIN_DAYS_MIN || days > EXPIRING_WITHIN_DAYS_MAX) {
    throw new RangeError(
      `expiring_within_days must be an integer between ${EXPIRING_WITHIN_DAYS_MIN} and ${EXPIRING_WITHIN_DAYS_MAX}, got ${days}`,
    );
  }
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) {
    throw new RangeError(`expiringWindow needs a parseable ISO timestamp, got ${nowIso}`);
  }
  return {
    after: new Date(nowMs).toISOString(),
    onOrBefore: new Date(nowMs + days * DAY_MS).toISOString(),
  };
}
