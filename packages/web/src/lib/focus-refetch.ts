/**
 * When regaining focus should refetch the dashboard's data.
 *
 * React Query already refetches on window focus, but only for queries it
 * considers stale, and this app deliberately runs a 60 s `staleTime` (90 s for
 * the scope tree and the label catalog) so that navigating between pages does
 * not re-request everything. The consequence is the one the user actually
 * notices: switch to another app, an agent writes lore, switch back inside the
 * freshness window and the dashboard confidently shows the old data with no
 * indication that anything is missing.
 *
 * Coming back to the window is an explicit "show me what's there now", so it
 * refetches the ACTIVE queries regardless of their `staleTime` — the freshness
 * window is about background chatter, not about an intentional return.
 *
 * The cooldown is what keeps that from being expensive. Focus fires far more
 * often than a person "comes back": clicking into the window from a devtools
 * pane, a browser dialog closing, a screenshot tool taking focus. Anything
 * within `FOCUS_REFETCH_COOLDOWN_MS` of the last refetch is the same return.
 */

/** Minimum spacing between two focus-driven refetches. */
export const FOCUS_REFETCH_COOLDOWN_MS = 2_000;

interface FocusRefetchInput {
  /** When the last focus-driven refetch ran, or null if none has yet. */
  lastRefetchAt: number | null;
  /** Now, in the same epoch as `lastRefetchAt`. */
  now: number;
  /** @default FOCUS_REFETCH_COOLDOWN_MS */
  cooldownMs?: number;
}

/**
 * Total function: a missing, future or non-finite `lastRefetchAt` all resolve to
 * "refetch". A clock that jumped must not be able to wedge the dashboard into
 * never refreshing again — the cost of an extra refetch is one request, the
 * cost of a wedged cooldown is permanently stale data.
 */
export function shouldRefetchOnFocus({
  lastRefetchAt,
  now,
  cooldownMs = FOCUS_REFETCH_COOLDOWN_MS,
}: FocusRefetchInput): boolean {
  if (lastRefetchAt === null || !Number.isFinite(lastRefetchAt)) return true;
  const elapsed = now - lastRefetchAt;
  if (elapsed < 0) return true;
  return elapsed >= cooldownMs;
}
