/**
 * How a figure is rendered on the dashboard.
 *
 * Three renderings, because the same kind of number appears in three very
 * different slots: a stat card, which has a column to itself; the Explorer's
 * collapsed strip, which gives four figures a quarter of a phone's width each;
 * and a trend chip, which shares one line with the figure it annotates and is
 * tighter than either.
 *
 * **All of them pin `'en-US'` rather than using the runtime default.** A bare
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

/**
 * Compact, capped at THREE significant digits: `12345` → `12.3K`, `1566285` →
 * `1.57M`, `883400` → `883K`.
 *
 * Significant digits rather than `maximumFractionDigits: 1`, because a fraction
 * cap is unbounded in the hundreds band (`883400` → `883.4K`, six characters),
 * while three significant digits is never more than five characters at any
 * magnitude — which is the width the headline slot is sized for.
 */
const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 3,
});

/**
 * Compact, capped at TWO significant digits: `883400` → `880K`, `8834` → `8.8K`.
 *
 * Same vocabulary as {@link COMPACT} — same locale, same `K`/`M`/`B` — carrying
 * one fewer digit of precision, because the slot that uses it is tighter: two
 * significant digits is never more than four characters at any magnitude, which
 * a trend chip's sign and `%` then stretch to six.
 */
const COMPACT_TERSE = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 2,
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

/**
 * Above this, a stat card's HEADLINE is abbreviated.
 *
 * Below it the exact, grouped figure is at most five characters (`9,999`) — the
 * same width compact notation tops out at (`12.3K`, `1.57M`) — so abbreviating
 * earlier would drop precision and buy no room. At it, `10,000` is six and the
 * figures only grow: `1,566,285` pushed the trend chip beside it off the card.
 */
const HEADLINE_COMPACT_THRESHOLD = 10_000;

/**
 * Above this, a PERCENTAGE is abbreviated.
 *
 * An order of magnitude lower than {@link COMPACT_THRESHOLD} because the slot is
 * an order of magnitude tighter. A trend chip shares one line with the headline
 * figure it annotates, and it carries two characters of overhead the figure does
 * not — a sign and a `%` — so `+8834%` is seven characters in a gap sized for
 * four or five. At a four-digit percentage it collided with a `22,425` beside it
 * on a desktop and was clipped at the card's edge on a phone.
 *
 * 1000, and not lower, because three digits is where a percentage stops being a
 * number people read as a quantity: `+100%` means "doubled" and must survive
 * verbatim, while `+8834%` is already being read as "a lot" — abbreviating it
 * loses nothing a reader was using. It is also the first magnitude that does not
 * fit, so the threshold is where the problem starts rather than a round number
 * picked for looking tidy.
 */
const PERCENT_COMPACT_THRESHOLD = 1_000;

/** The exact, grouped figure. Used by the stat cards and by every announcement. */
export function formatExact(value: number): string {
  return EXACT.format(value);
}

/**
 * Plain digits below `threshold`, compact notation at or above it.
 *
 * The ONE compact rendering on the dashboard, parameterised by the width of the
 * slot asking. Two thresholds and two precisions, one vocabulary: a `K` means the
 * same thing in a headline figure and in a trend chip, which is the property that
 * would break the moment a second call site rolled its own abbreviation.
 *
 * `Intl`'s compact notation supplies the rounding rules so they do not have to be
 * hand-written: it drops a fraction digit when it is zero, so `2000` → `2K`
 * (never `2.0K`), and it rounds ACROSS a magnitude rather than showing another
 * decimal, so `9950` reads `10K` and not `9.95K` or `10.0K`.
 */
function compactAbove(value: number, threshold: number, formatter: Intl.NumberFormat): string {
  return Math.abs(value) < threshold ? String(Math.trunc(value)) : formatter.format(value);
}

/**
 * The figure as it should appear in a narrow, dense slot.
 *
 * Ungrouped below the threshold and compact above it, so the result is at most
 * five characters at any magnitude. Grouping is dropped rather than kept
 * because the separator is the character that pushes a four-digit figure past
 * its column, and it buys little there.
 *
 * The exact value is never lost: `AnimatedNumber` announces {@link formatExact}
 * regardless of how it renders.
 */
export function formatCompact(value: number): string {
  return compactAbove(value, COMPACT_THRESHOLD, COMPACT);
}

/**
 * A stat card's headline figure: `5,341`, `12.3K`, `1.57M`.
 *
 * Exact and grouped below {@link HEADLINE_COMPACT_THRESHOLD}, compact above it,
 * so a headline is never wider than five characters and always leaves the trend
 * chip on its row room to sit beside it. The exact value stays reachable:
 * `AnimatedNumber` announces {@link formatExact}, and `StatCard` puts it in the
 * hover title when {@link isHeadlineAbbreviated}.
 */
export function formatHeadline(value: number): string {
  return Math.abs(value) < HEADLINE_COMPACT_THRESHOLD ? EXACT.format(value) : COMPACT.format(value);
}

/** Whether {@link formatHeadline} lost precision on this value. */
export function isHeadlineAbbreviated(value: number): boolean {
  return Math.abs(value) >= HEADLINE_COMPACT_THRESHOLD;
}

/**
 * A period-over-period change, signed and suffixed, for a trend chip.
 *
 * `+42%`, `-7%`, `0%` below {@link PERCENT_COMPACT_THRESHOLD} — byte-identical to
 * what the chip rendered before, so no small delta moves. At or above it, the
 * magnitude abbreviates: `+8.8K%`, `-2M%`.
 *
 * The explicit `+` is not decoration: the chip is coloured by direction and read
 * at a glance, and a bare `42%` next to a red arrow is ambiguous about whether it
 * fell BY 42% or TO 42%.
 *
 * Callers that abbreviate should keep the exact value reachable — see
 * {@link isPercentDeltaAbbreviated} and how `TrendChip` uses it.
 */
export function formatPercentDelta(changePct: number): string {
  const sign = changePct > 0 ? '+' : '';
  return `${sign}${compactAbove(changePct, PERCENT_COMPACT_THRESHOLD, COMPACT_TERSE)}%`;
}

/**
 * Whether {@link formatPercentDelta} lost precision on this value.
 *
 * Lets a caller add the exact figure for assistive tech and on hover ONLY where
 * something was actually dropped, so the common case stays one plain text node.
 */
export function isPercentDeltaAbbreviated(changePct: number): boolean {
  return Math.abs(changePct) >= PERCENT_COMPACT_THRESHOLD;
}
