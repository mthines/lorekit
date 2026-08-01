/**
 * Pure display helpers for blog metadata. No clock, no locale surprises — a fixed
 * `en-US`, UTC-parsed formatter so a post's date renders identically on the server
 * and the client (no hydration mismatch) and in tests.
 */

/** `2026-08-01` → `August 1, 2026`. Returns the raw input unchanged when it doesn't
 *  start with a `YYYY-MM-DD` prefix OR when that prefix is out of range (e.g.
 *  `2026-13-45`), so a malformed frontmatter date degrades to the raw string instead
 *  of silently rolling over to a valid-but-wrong date (`Date.UTC` rolls month 13 into
 *  the next January). */
export function formatPostDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Require the constructed date to round-trip back to the exact parts; any mismatch
  // means `Date.UTC` rolled an out-of-range value over, so degrade to the raw input.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return iso;
  }
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
