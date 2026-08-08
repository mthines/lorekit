/**
 * The ONE time model the Overview and the Lore Explorer share.
 *
 * Both pages already had a notion of "the selected period", and they were not
 * the same notion: the Explorer kept a `{from, to}` pair of UTC DAY STRINGS in
 * the URL, while the Overview kept a `'24h' | '7d' | '30d'` preset in local
 * React state. Neither could express the other's selection, so a number on the
 * Overview could not link to the list that produced it, and a bar on a chart
 * could not narrow the page it was drawn on. This module is the vocabulary both
 * now speak, precise to the hour.
 *
 * ## Relative in, absolute out — and the URL keeps whichever one you meant
 *
 * A selection is one of two genuinely different things, and collapsing them
 * loses information:
 *
 * - A **preset** (`{ preset: '7d' }`) is a QUESTION that stays true over time —
 *   "the last seven days", whenever you ask. It stays relative in the URL, so a
 *   bookmarked or shared link keeps answering it tomorrow.
 * - An **absolute window** (`{ from, to }`) is a MOMENT you are pointing at —
 *   the hour a spike happened, the day someone wants a second opinion on. It is
 *   stored as instants, so the link keeps showing that spike and not "whatever
 *   is happening now".
 *
 * Freezing a preset into instants at click time would silently convert every
 * shared "last 7 days" link into a stale snapshot; resolving an absolute window
 * relative to the reader's clock would move the spike. So the URL preserves the
 * distinction, and **every form resolves to absolute instants at read time** via
 * {@link resolveRange}. Nothing downstream — the API call, the bucket grid, the
 * charts — ever sees a relative value. This is the same reasoning that made
 * `GET /memories?expiring_within_days=` a relative horizon rather than an
 * absolute `expires_before` timestamp.
 *
 * ## Windows are half-open `[from, to)`
 *
 * Matching `GET /memories/activity`, `/read-activity` and `/usage`, and matching
 * what `dateRangeBounds` already emits (`gte` / `lt`). Adjacent buckets tile the
 * timeline exactly once with no double-counted boundary instant — which is what
 * lets a drilled-down bucket's total agree with the bar it was drawn from.
 *
 * (`expiring_within_days`'s `(now, bound]` is deliberately the other way round;
 * that one's lower bound is not a window edge but the definition of "live".)
 *
 * Pure and clock-injected throughout, so every rule below is unit-testable and
 * no function here reads `Date.now()`.
 */

/**
 * The relative windows a picker offers. `all` is unbounded — it resolves to
 * `null`, not to a very large window, so "no filter" stays genuinely absent
 * rather than becoming an arbitrary horizon a reader has to second-guess.
 */
export type RangePreset = '24h' | '7d' | '30d' | '90d' | 'all';

export const RANGE_PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', '90d', 'all'] as const;

/** Bucket granularity. Hour is the finest — see {@link HOUR_LADDER_MAX_MS}. */
export type BucketUnit = 'hour' | 'day';

/** A bucket grid: the unit, and how many of them the window spans. */
export interface BucketPlan {
  unit: BucketUnit;
  count: number;
}

/** A resolved window of instants, half-open `[from, to)`. Both ISO. */
export interface AbsoluteRange {
  from: string;
  to: string;
}

/**
 * What lives in `?range=`.
 *
 * `null` means unbounded. The `{ from, to }` arm accepts BOTH ISO instants and
 * the legacy `YYYY-MM-DD` day strings the Explorer has always written — see
 * {@link resolveRange}.
 */
export type TimeRange = { preset: RangePreset } | AbsoluteRange | null;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * The longest window still charted in HOURLY buckets.
 *
 * 48 hours is 48 bars, which is about the most a sparkbar can show before the
 * bars stop being individually hittable — and this ladder exists to make bars
 * clickable (PR-6). Past it, days: a 7-day window as 168 hourly bars would be a
 * texture, not a chart.
 *
 * The threshold is INCLUSIVE (a window of exactly 48h is hourly) so the two
 * common selections either side of it — "yesterday and today" and "this week" —
 * each land on the granularity a reader expects rather than on a boundary case.
 */
export const HOUR_LADDER_MAX_MS = 48 * HOUR_MS;

const DAY_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a `?range=` value is the relative arm. */
export function isPresetRange(range: TimeRange): range is { preset: RangePreset } {
  return range !== null && 'preset' in range;
}

/** Whether a bound is a legacy `YYYY-MM-DD` day string rather than an instant. */
export function isDayString(value: string): boolean {
  return DAY_ONLY_RE.test(value);
}

/** Milliseconds a preset spans, or `null` for the unbounded `all`. */
function presetSpanMs(preset: RangePreset): number | null {
  switch (preset) {
    case '24h': return 24 * HOUR_MS;
    case '7d': return 7 * DAY_MS;
    case '30d': return 30 * DAY_MS;
    case '90d': return 90 * DAY_MS;
    case 'all': return null;
  }
}

/**
 * Resolve a `?range=` value into absolute instants, or `null` for unbounded.
 *
 * Three input shapes, one output shape:
 *
 * 1. `null` / `{ preset: 'all' }` → `null`. Unbounded stays unbounded.
 * 2. `{ preset }` → `[now − span, now)`, measured from the INJECTED clock.
 * 3. `{ from, to }` → those instants, with the legacy day-string rule applied.
 *
 * **The legacy rule, stated exactly, because old shared links depend on it:** a
 * bare `YYYY-MM-DD` has always meant a whole UTC DAY, and a `to` day has always
 * been INCLUSIVE — `{from: '2026-07-01', to: '2026-07-03'}` is three days, not
 * two. Under a half-open window that is `[2026-07-01T00:00Z, 2026-07-04T00:00Z)`,
 * so the `to` day is expanded to the START OF THE NEXT day. This reproduces
 * `dateRangeBounds`' existing behaviour instant-for-instant, which is what makes
 * resolving here (rather than passing the raw pair through) behaviour-preserving
 * for every link already in the wild. An ISO `to` is already an instant and is
 * taken as the exclusive bound verbatim.
 *
 * An unparseable bound yields `null` (unbounded) rather than throwing or
 * silently clamping: `?range=` is hand-editable and arrives from links of
 * unknown age, so the failure mode has to be "you get everything", which is
 * visible, rather than "you get a window nobody asked for", which is not.
 */
export function resolveRange(range: TimeRange, nowIso: string): AbsoluteRange | null {
  if (range === null) return null;

  if (isPresetRange(range)) {
    const span = presetSpanMs(range.preset);
    if (span === null) return null;
    const now = Date.parse(nowIso);
    if (Number.isNaN(now)) return null;
    return { from: new Date(now - span).toISOString(), to: new Date(now).toISOString() };
  }

  const from = parseLowerBound(range.from);
  const to = parseUpperBound(range.to);
  if (from === null || to === null) return null;
  // A backwards or empty window is a malformed link, not a selection that
  // returns nothing — same fail-open posture as an unparseable bound.
  if (to <= from) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** A day string is the START of that UTC day; an instant is itself. */
function parseLowerBound(value: string): number | null {
  const ms = Date.parse(isDayString(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(ms) ? null : ms;
}

/** A day string is INCLUSIVE, so its exclusive bound is the next day's start. */
function parseUpperBound(value: string): number | null {
  if (isDayString(value)) {
    const start = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isNaN(start) ? null : start + DAY_MS;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Pick the bucket grid for a resolved window — the range→bucket ladder.
 *
 * `count` is how many whole buckets the window spans, rounded UP so a partial
 * trailing bucket is still charted (a 90-minute window is 2 hourly bars, not 1),
 * and floored at 1 so a sub-bucket window still has something to draw.
 */
export function bucketPlanFor(window: AbsoluteRange): BucketPlan {
  const span = Date.parse(window.to) - Date.parse(window.from);
  const unit: BucketUnit = span <= HOUR_LADDER_MAX_MS ? 'hour' : 'day';
  const unitMs = unit === 'hour' ? HOUR_MS : DAY_MS;
  return { unit, count: Math.max(1, Math.ceil(span / unitMs)) };
}

/**
 * The bucket grid for a `?range=` value, or `null` when it is unbounded.
 *
 * Unbounded has no grid by construction — "all time" has no start to count
 * buckets from — so the caller has to decide what to chart. Returning `null`
 * makes that decision explicit at the call site rather than inventing a horizon
 * here that every reader would then have to discover.
 */
export function bucketPlanForRange(range: TimeRange, nowIso: string): BucketPlan | null {
  const window = resolveRange(range, nowIso);
  return window === null ? null : bucketPlanFor(window);
}

/**
 * The window covered by ONE bucket of a chart — the drill-down builder.
 *
 * Clicking an hour bar selects that hour; clicking a day cell selects that day.
 * The result is always an ABSOLUTE range, never a preset: the user pointed at a
 * specific moment, and the link they then share has to keep pointing at it.
 *
 * `bucketStart` is the UTC start the server already anchored the bucket to
 * (`date_trunc` in `lorekit_memory_activity` / `lorekit_read_activity`), so this
 * only has to add one unit — it must NOT re-truncate. Re-truncating would be a
 * silent no-op today and a wrong answer the moment a caller passes a bucket that
 * is not aligned, which is exactly the bug that would survive review.
 */
export function rangeForBucket(bucketStart: string, unit: BucketUnit): AbsoluteRange {
  const start = Date.parse(bucketStart);
  if (Number.isNaN(start)) {
    throw new RangeError(`rangeForBucket needs a parseable bucket start, got ${bucketStart}`);
  }
  const span = unit === 'hour' ? HOUR_MS : DAY_MS;
  return { from: new Date(start).toISOString(), to: new Date(start + span).toISOString() };
}

/**
 * Express a resolved window as INCLUSIVE UTC day strings, for the surfaces that
 * only speak days — the calendar picker and the contribution heatmap, both of
 * which highlight whole cells.
 *
 * The `to` day is the day containing the last instant INSIDE the window, not the
 * day of the exclusive bound. Without that one-millisecond step back, a window
 * ending at midnight would light up an extra cell the selection does not
 * actually include — the same off-by-one {@link rangeLabel} guards against.
 */
export function toDayRange(window: AbsoluteRange): { from: string; to: string } {
  return {
    from: window.from.slice(0, 10),
    to: new Date(Date.parse(window.to) - 1).toISOString().slice(0, 10),
  };
}

/** Whether a window starts at UTC midnight and spans a whole number of days. */
function isWholeDayWindow(window: AbsoluteRange): boolean {
  const from = Date.parse(window.from);
  const span = Date.parse(window.to) - from;
  return from % DAY_MS === 0 && span % DAY_MS === 0;
}

/**
 * Human label for a range, for the picker trigger and the chart caption.
 *
 * An absolute window renders its dates rather than a duration: it was chosen by
 * pointing at something, so the dates are the information.
 */
export function rangeLabel(range: TimeRange, nowIso: string): string {
  if (range === null || (isPresetRange(range) && range.preset === 'all')) return 'All time';
  if (isPresetRange(range)) {
    return { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' }[
      range.preset as Exclude<RangePreset, 'all'>
    ];
  }
  const window = resolveRange(range, nowIso);
  if (window === null) return 'All time';
  // Granularity here is the WINDOW's alignment, deliberately NOT the bucket
  // ladder's unit. A single day is charted in hourly buckets (24h sits at the
  // hour end of the ladder), but it was selected as a day and must read as
  // "Jul 1" — not "Jul 1, 12:00 AM – Jul 1, 11:59 PM", which is the same
  // information dressed up as noise. Only a window that does not land on whole
  // UTC days has a time worth showing.
  const opts: Intl.DateTimeFormatOptions = isWholeDayWindow(window)
    ? { month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' };
  const from = new Date(window.from);
  // The stored `to` is EXCLUSIVE, so render the last instant INSIDE the window —
  // a day range must not read as ending on the following midnight.
  const to = new Date(Date.parse(window.to) - 1);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, opts);
  const left = fmt(from);
  const right = fmt(to);
  return left === right ? left : `${left} – ${right}`;
}
