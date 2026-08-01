/**
 * Pure display helpers for blog metadata. No clock, no locale surprises — a fixed
 * `en-US`, UTC-parsed formatter so a post's date renders identically on the server
 * and the client (no hydration mismatch) and in tests.
 */

/** `2026-08-01` → `August 1, 2026`. Returns the raw input unchanged when it doesn't
 *  start with a `YYYY-MM-DD` prefix, so a malformed frontmatter date degrades instead
 *  of throwing. A prefix that matches but is out of range is not rejected — it rolls
 *  over the way `Date.UTC` does (`2026-13-45` → `February 14, 2027`). */
export function formatPostDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  // The regex guarantees three finite integers, so `Date.UTC` can never return NaN here.
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** `8` → `8 min read`. Clamps to a sensible floor so a missing/zero value never
 *  renders "0 min read". */
export function readingLabel(minutes: number): string {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 1;
  return `${m} min read`;
}
