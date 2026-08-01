/**
 * Pure display helpers for blog metadata. No clock, no locale surprises — a fixed
 * `en-US`, UTC-parsed formatter so a post's date renders identically on the server
 * and the client (no hydration mismatch) and in tests.
 */

/** `2026-08-01` → `August 1, 2026`. Returns the raw input unchanged if it isn't a
 *  parseable ISO date, so a malformed frontmatter date degrades instead of throwing. */
export function formatPostDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return iso;
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
