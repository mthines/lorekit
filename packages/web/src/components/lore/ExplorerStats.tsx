'use client';

/**
 * The Lore Explorer's selection-aware stats header.
 *
 * The Overview's stat row answers "how is my lore doing" for the whole account.
 * This answers the same question for whatever the Explorer is currently showing
 * — so the number and the list that produced it finally sit on one page, and a
 * scope click moves both.
 *
 * Four cards, and the order is the reading order: the two memory-count cards
 * sit together (written, then read) so like compares with like, then the
 * breadth card, then the one that is a warning rather than a measurement.
 *
 * ## The two things it cannot scope, and says so
 *
 * - **Expired is account-wide.** `usage_events` carries no scope on the expiry
 *   event, because the purge is per-user and spans scopes. Its tooltip says so
 *   and its caption drops the scope name.
 * - **The filter bar does not narrow any of it.** `/activity`,
 *   `/read-activity` and `/usage` take a window (and the read series a scope);
 *   none takes the Explorer's dimension filters. Rather than let four numbers
 *   quietly disagree with the list under them, the header states the mismatch
 *   inline the moment a filter is active.
 *
 * Both are the honest rendering of what the API can answer today. Neither is
 * papered over, because a stat header that is subtly wrong is worse than one
 * that admits its scope.
 */

import { useMemo, useState } from 'react';
import { BookOpen, BookOpenCheck, ChevronDown, ChevronUp, Hourglass, Layers } from 'lucide-react';
import { StatCard } from '@/components/dashboard/StatCard';
import {
  effectiveStatsRange,
  statsWindow,
  useExplorerStats,
} from '@/lib/queries/explorer-stats';
import {
  computeCountTrend,
  computeRangeTrends,
  RANGE_BUCKETS,
} from '@/lib/aggregations';
import {
  bucketPlanForRange,
  gridAnchor,
  rangeCaption,
  rangeLabel,
  type TimeRange,
} from '@/lib/time-range';

const sumPoints = (points: { value: number }[]) => points.reduce((total, p) => total + p.value, 0);

/**
 * The grid an unbounded or unparseable range falls back to — the same 30 daily
 * buckets the Overview uses, for the same reason: rendering nothing would turn
 * a bad link into a broken page.
 */
const FALLBACK_PLAN = RANGE_BUCKETS['30d'];

interface ExplorerStatsProps {
  /** The selected scope, or null for all scopes. */
  scope: string | null;
  /** The Explorer's shared time range. */
  range: TimeRange;
  /** Whether the filter bar currently narrows the list but not these numbers. */
  hasActiveFilters: boolean;
  /** Human label for the selected scope, for captions. */
  scopeLabel: string;
}

export function ExplorerStats({
  scope,
  range,
  hasActiveFilters,
  scopeLabel,
}: ExplorerStatsProps) {
  // Ephemeral, like the heatmap panel's collapse — a reader who folds the
  // header away is decluttering their view, not choosing something to share.
  const [open, setOpen] = useState(true);

  // One clock per mount, so the window, the grid anchor and the captions all
  // describe the same instant. Re-reading `Date.now()` at each site would let a
  // render straddle a bucket boundary and caption a chart it did not draw.
  const nowIso = useMemo(() => new Date().toISOString(), []);
  // Every derivation below hangs off the EFFECTIVE range, never the raw
  // selection: an unbounded selection charts 90 days, so it must also be
  // captioned as 90 days. See `effectiveStatsRange`.
  const shown = useMemo(() => effectiveStatsRange(range, nowIso), [range, nowIso]);
  const plan = useMemo(() => bucketPlanForRange(shown, nowIso) ?? FALLBACK_PLAN, [shown, nowIso]);
  const queryWindow = useMemo(() => statsWindow(shown, nowIso), [shown, nowIso]);

  const { data, isLoading, isError, isFetching } = useExplorerStats(
    scope,
    plan.unit,
    queryWindow.since,
    queryWindow.until,
  );

  // The absolute arm anchors its grid at its own end, not at the clock — see
  // `gridAnchor`. Shared with the Overview so the two pages bucket identically.
  const gridNowIso = useMemo(() => gridAnchor(shown, nowIso), [shown, nowIso]);
  const rows = data?.rows;
  const readBuckets = data?.readBuckets;
  const memoryTrends = useMemo(
    () => computeRangeTrends(rows ?? [], gridNowIso, plan),
    [rows, gridNowIso, plan],
  );
  const readTrend = useMemo(
    () => computeCountTrend(readBuckets ?? [], gridNowIso, plan),
    [readBuckets, gridNowIso, plan],
  );

  const rangeText = rangeCaption(shown, nowIso);
  const rangeTitle = rangeLabel(shown, nowIso);
  const scopeText = scope ? ` in ${scopeLabel}` : '';
  const trendTitle = `${rangeTitle} vs. the preceding period of the same length`;

  const cards: ({ id: string } & Omit<
    Parameters<typeof StatCard>[0],
    'trendTitle' | 'rangeTitle'
  >)[] = [
    {
      id: 'written',
      icon: BookOpen,
      label: 'Memories written',
      tag: 'Memory writes',
      tooltip: `Memories written${scope ? ` under ${scopeLabel}` : ' across every scope'} in the selected range. The bars sum to the number: each bar is the memories written in that hour or day.`,
      value: sumPoints(memoryTrends.lessons.points),
      description: `in ${rangeText}${scopeText}`,
      trend: memoryTrends.lessons,
      unit: 'memories',
    },
    {
      id: 'read',
      icon: BookOpenCheck,
      label: 'Memories read',
      tag: 'Memory reads',
      // The caveat PR-1 deferred to this card, stated where the number is read.
      tooltip: scope
        ? `Memory RECORDS read under ${scopeLabel} in the selected range — one list call returning 20 memories counts as 20. Only reads LoreKit could attribute to a scope are counted, so a per-scope total can be smaller than the account total: a read whose scope the server could not resolve is recorded unattributed rather than dropped. Reads from this dashboard are excluded — browsing your lore is visualisation, not consumption — and usage is a per-user ledger, so a co-member's reads are never included.`
        : 'Memory RECORDS read in the selected range — one list call returning 20 memories counts as 20, not one. Reads from this dashboard are excluded: browsing your lore is visualisation, not consumption. Usage is a per-user ledger, so a co-member\u2019s reads are never included.',
      value: sumPoints(readTrend.points),
      description: `in ${rangeText}${scopeText}`,
      trend: readTrend,
      unit: 'memories',
    },
    {
      id: 'scopes',
      icon: Layers,
      label: 'Scopes active',
      tag: 'Scope breadth',
      tooltip:
        'Distinct scopes with at least one memory written in the selected range. Each bar is the scopes seen for the FIRST time in that hour or day, so the bars sum to the distinct total rather than counting a long-running scope once per bucket.',
      value: memoryTrends.activeScopes,
      description: `distinct scopes active in ${rangeText}`,
      trend: memoryTrends.newScopes,
      unit: 'scopes',
    },
    {
      id: 'expired',
      icon: Hourglass,
      label: 'Memories expired',
      tag: 'Expiry',
      tooltip:
        'Memory records deleted in the selected range because their TTL ran out. Counted when the nightly purge removes them, which is the only moment expiry is observable — a read simply hides an expired row. This figure is ACCOUNT-WIDE even when a scope is selected: the purge runs per user and spans scopes, so the underlying event carries no scope to filter on.',
      value: data?.expired ?? 0,
      // No scope suffix, deliberately — see the tooltip.
      description: `across your account in ${rangeText}`,
      // No series: the API reports expiry as a total with no per-bucket
      // breakdown, so there is nothing honest to draw. StatCard renders the
      // number alone rather than an empty chart.
    },
  ];

  return (
    <section
      aria-label="Statistics for the current selection"
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <p className="text-xs font-medium text-[var(--color-content-tertiary)]">
            {scope ? `Activity · ${scopeLabel}` : 'Activity · all scopes'}
          </p>
          {/* Stated only when it can actually mislead: with a filter bar active,
              the list below shows fewer memories than these numbers count. */}
          {hasActiveFilters && open && (
            <p className="mt-0.5 text-[10px] text-[var(--color-content-tertiary)] opacity-70">
              Counts the selected scope and range — filters narrow the list below, not these
              numbers.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Hide statistics' : 'Show statistics'}
          className="flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--color-content-tertiary)] transition-colors duration-150 hover:text-[var(--color-content-secondary)]"
        >
          {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-4">
          {isError ? (
            <p className="text-sm text-[var(--color-content-secondary)]">
              Failed to load statistics for this selection.
            </p>
          ) : (
            <div
              // The held-frame rule: while a new selection loads, the PREVIOUS
              // render stays put at reduced opacity instead of collapsing to
              // skeletons. Four cards blanking on every scope click reads as the
              // page breaking, and the layout jump loses the reader's place.
              // Only the very first load — where there is no previous frame to
              // hold — shows the dimmed empty state.
              className={[
                'grid grid-cols-1 gap-3 transition-opacity duration-150 sm:grid-cols-2 lg:grid-cols-4',
                isFetching || isLoading ? 'opacity-60' : 'opacity-100',
              ].join(' ')}
              aria-busy={isFetching || isLoading}
            >
              {cards.map(({ id, ...card }) => (
                <StatCard key={id} {...card} trendTitle={trendTitle} rangeTitle={rangeTitle} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

