/**
 * The pure model behind the visual Insights page (`insights-visual`): the
 * Learn → Recall → Promote → Prune strip and the Pulse timeline.
 *
 * ## One window, and the figures it can honestly carry
 *
 * The strip states four stages of the loop LoreKit runs, and each figure comes
 * from the ONE source that can carry it — never a second source that happens to
 * be nearby:
 *
 *   - **Learn** — lessons CREATED in the window (`/memories/activity`). Not
 *     `memory.write` calls: a re-write of an existing key is also a write, and
 *     no endpoint buckets re-writes over time yet, so mixing the two would make
 *     the headline disagree with the bars drawn under it.
 *   - **Recall** — memory RECORDS read (`/memories/read-activity`), split into
 *     `targeted` (an agent chose this lesson) and `bulk` (it rode along in a
 *     list/search page). Records, not calls — the additive figure a bar can sum.
 *   - **Promote** — the `load-bearing` and `specialist` counts of the utility
 *     census. ALL-TIME by construction (it reads lifetime counters), so it has
 *     no period delta and the strip says so rather than inventing one.
 *   - **Prune** — `memory.archive` calls plus TTL-expired records in the window
 *     (`/memories/usage` summary). Window totals only: there is no bucketed
 *     lifecycle series yet, so this stage draws no bars.
 *
 * ## The row cap is a real ceiling, so it is checked rather than assumed away
 *
 * The activity series arrive as one row per `(bucket, scope[, read_kind])`, and
 * PostgREST returns at most `max_rows` (1000, `supabase/config.toml`) rows from
 * the RPC — with no error. A long window over many scopes can reach it, and
 * because the RPC orders by bucket ascending, the rows it drops are the NEWEST
 * ones: the chart would show a cliff to zero at "now". {@link isAtRowCap} lets
 * the page say "this may be incomplete" instead of drawing that cliff as fact.
 *
 * Pure and total: every function answers for an empty account without a
 * division by zero and without a caller-side guard.
 */

import type { ActivityBucket, ReadActivityBucket, UtilityCensus } from '@lorekit/schemas/memory';
import type { UsageSummary } from '@lorekit/schemas/usage';
import { pctChange } from '@/lib/aggregations';
import { DAY_MS, HOUR_MS, type AbsoluteRange, type BucketUnit } from '@/lib/time-range';

/** PostgREST's `max_rows` for this project (`supabase/config.toml`). */
export const ROW_CAP = 1000;

/**
 * Whether a series response may have been truncated by {@link ROW_CAP}.
 *
 * `>=`, not `===`: the cap is a ceiling the server enforces, so a count at or
 * above it means "we cannot tell what was dropped". Exactly-1000 genuine rows is
 * indistinguishable from a truncated response, and saying "may be incomplete"
 * about a complete one is the cheaper mistake.
 */
export function isAtRowCap(rowCount: number): boolean {
  return rowCount >= ROW_CAP;
}

function unitMs(unit: BucketUnit): number {
  return unit === 'hour' ? HOUR_MS : DAY_MS;
}

/**
 * Every bucket start (UTC, ISO) whose bucket intersects `window`.
 *
 * Anchored the way the server anchors its buckets (`date_trunc` on UTC), so a
 * server row lands on exactly one of these. The first and last buckets are
 * usually PARTIAL: the server filters `>= since`, so a 7-day window opened at
 * 14:00 yields 8 day bars whose first holds only that day's afternoon.
 */
export function bucketStarts(window: AbsoluteRange, unit: BucketUnit): string[] {
  const step = unitMs(unit);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return [];
  const starts: string[] = [];
  for (let t = Math.floor(from / step) * step; t < to; t += step) {
    starts.push(new Date(t).toISOString());
  }
  return starts;
}

/** One bucket of the Pulse timeline. */
export interface PulseBucket {
  /** UTC start of the bucket, ISO. */
  start: string;
  /** Lessons created in the bucket, summed across scopes. */
  written: number;
  /** Records an agent fetched on purpose (`memory.read`). */
  chosen: number;
  /** Records that rode along in a list/search page. */
  bulk: number;
}

/**
 * The Pulse series: one entry per bucket of the window, zeros included.
 *
 * Zeros are kept because a gap IS the information on a time axis — a missing
 * Tuesday must render as an empty Tuesday, not as Monday sitting next to
 * Wednesday. A `read_kind` absent from the row (a pre-00080 response) counts as
 * `bulk`: the conservative reading, since `chosen` is a claim that an agent
 * deliberately reached for the lesson and an untyped row cannot support it.
 */
export function pulseBuckets(
  window: AbsoluteRange,
  unit: BucketUnit,
  writes: readonly ActivityBucket[],
  reads: readonly ReadActivityBucket[],
): PulseBucket[] {
  const step = unitMs(unit);
  const buckets = bucketStarts(window, unit).map((start) => ({ start, written: 0, chosen: 0, bulk: 0 }));
  const index = new Map(buckets.map((b, i) => [Date.parse(b.start), i]));
  const slot = (iso: string): PulseBucket | undefined => {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return undefined;
    const i = index.get(Math.floor(t / step) * step);
    return i === undefined ? undefined : buckets[i];
  };

  for (const row of writes) {
    const bucket = slot(row.bucket);
    if (bucket) bucket.written += row.count;
  }
  for (const row of reads) {
    const bucket = slot(row.bucket);
    if (!bucket) continue;
    if (row.read_kind === 'targeted') bucket.chosen += row.count;
    else bucket.bulk += row.count;
  }
  return buckets;
}

/** Sums of a Pulse series — the totals the strip's headline figures state. */
export interface PulseTotals {
  written: number;
  chosen: number;
  bulk: number;
}

export function pulseTotals(buckets: readonly PulseBucket[]): PulseTotals {
  return buckets.reduce(
    (acc, b) => ({ written: acc.written + b.written, chosen: acc.chosen + b.chosen, bulk: acc.bulk + b.bulk }),
    { written: 0, chosen: 0, bulk: 0 },
  );
}

/**
 * Totals for the PREVIOUS window, straight from the raw rows.
 *
 * No bucket grid is needed — the previous window only ever feeds a delta — so
 * this skips {@link pulseBuckets} and sums every row the server returned for
 * that window.
 */
export function rawTotals(writes: readonly ActivityBucket[], reads: readonly ReadActivityBucket[]): PulseTotals {
  let written = 0;
  let chosen = 0;
  let bulk = 0;
  for (const row of writes) written += row.count;
  for (const row of reads) {
    if (row.read_kind === 'targeted') chosen += row.count;
    else bulk += row.count;
  }
  return { written, chosen, bulk };
}

export interface LoopWindowInput {
  totals: PulseTotals;
  /** The `/usage` summary for the same window — the source of the Prune stage. */
  summary: Pick<UsageSummary, 'archived' | 'expired'>;
}

export interface LoopStages {
  learn: { created: number; changePct: number | null };
  recall: { records: number; chosen: number; changePct: number | null };
  promote: { loadBearing: number; specialist: number } | null;
  prune: { archived: number; expired: number; changePct: number | null };
  /** Learn and Recall come from a series that hit the row cap — they are lower bounds. */
  seriesIncomplete: boolean;
}

/**
 * A period delta, or `null` when there is nothing to compare against.
 *
 * `null` when BOTH windows are empty (0 → 0 is not "flat", it is no evidence)
 * and when the previous window is empty but this one is not: `pctChange` calls
 * that +100%, which a reader takes as "doubled" when it really means "started".
 * A chip is omitted rather than shown misleading.
 */
export function periodChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return pctChange(current, previous);
}

/**
 * The four stage figures, each from the one source that can carry it (see the module docblock).
 *
 * `seriesTruncated` — either window's activity series hit the row cap. Learn and
 * Recall are then lower bounds, and their deltas are dropped: a delta between
 * two figures that may each be missing rows is not a comparison.
 */
export function loopStages(
  current: LoopWindowInput,
  previous: LoopWindowInput,
  census: UtilityCensus | null,
  seriesTruncated = false,
): LoopStages {
  const records = current.totals.chosen + current.totals.bulk;
  const previousRecords = previous.totals.chosen + previous.totals.bulk;
  const pruned = current.summary.archived + current.summary.expired;
  const previousPruned = previous.summary.archived + previous.summary.expired;
  const delta = (now: number, before: number) => (seriesTruncated ? null : periodChange(now, before));
  return {
    learn: { created: current.totals.written, changePct: delta(current.totals.written, previous.totals.written) },
    recall: { records, chosen: current.totals.chosen, changePct: delta(records, previousRecords) },
    promote: census ? { loadBearing: census['load-bearing'], specialist: census.specialist } : null,
    prune: { archived: current.summary.archived, expired: current.summary.expired, changePct: periodChange(pruned, previousPruned) },
    seriesIncomplete: seriesTruncated,
  };
}

/**
 * Share of recalled records that were a deliberate fetch, or `null` with no reads.
 *
 * The same selection-not-influence caveat as the cost headline applies: a
 * lesson injected at session start never needs a second fetch to be acted on,
 * so a low share is "rarely looked up on purpose", not "wasted".
 */
export function chosenShare(stages: Pick<LoopStages, 'recall'>): number | null {
  return stages.recall.records === 0 ? null : stages.recall.chosen / stages.recall.records;
}
