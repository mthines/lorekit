/**
 * How a figure is rendered on the dashboard.
 *
 * Two renderings, because the same number appears in two very different slots:
 * a stat card, which has a column to itself, and the Explorer's collapsed strip,
 * which gives four figures a quarter of a phone's width each.
 *
 * **Both pin `'en-US'` rather than using the runtime default.** A bare
 * `toLocaleString()` resolves against whatever locale the runtime has, and the
 * server rendering the initial HTML is not the browser hydrating it — so the
 * same figure can format two ways and React reports a hydration mismatch. The
 * numbers that currently reach SSR are zeros (the queries are still loading, so
 * the cards render a skeleton or a 0), which makes this latent rather than
 * live — but the repo's own React data-fetching guidance points at
 * `HydrationBoundary`/`dehydrate`, and the day someone seeds these queries the
 * mismatch becomes real. `lib/blog/likes.ts` pins its locale for the same
 * reason; this follows that precedent.
 */

/** Grouped and exact: `1247` → `1,247`. The canonical rendering of a figure. */
const EXACT = new Intl.NumberFormat('en-US');

/** Compact: `12345` → `12.3K`. Mirrors `formatLikeCount`'s options. */
const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Above this, a figure is rendered compactly in width-constrained slots.
 *
 * Sized from the tightest slot that exists: the Explorer's collapsed strip is
 * four equal columns, which on a 320px phone leaves ~58px each, and its figures
 * are `text-xl` bold tabular-nums — about 12px per digit, so four characters
 * fit and six do not. Below the threshold the widest value is four digits;
 * above it, compact notation is never longer than five characters ("1.2M").
 */
const COMPACT_THRESHOLD = 10_000;

/** The exact, grouped figure. Used by the stat cards and by every announcement. */
export function formatExact(value: number): string {
  return EXACT.format(value);
}

/**
 * The figure as it should appear in a narrow, dense slot.
 *
 * Ungrouped below the threshold and compact above it, so the result is at most
 * five characters at any magnitude. Grouping is dropped rather than kept
 * because the separator is the character that pushes a four-digit figure past
 * its column, and it buys little at four digits.
 *
 * The exact value is never lost: `AnimatedNumber` announces {@link formatExact}
 * regardless of how it renders, and the expanded stat card shows it in full.
 */
export function formatCompact(value: number): string {
  return Math.abs(value) < COMPACT_THRESHOLD ? String(Math.trunc(value)) : COMPACT.format(value);
}
