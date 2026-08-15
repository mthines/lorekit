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
 * ## What follows the filter, and what cannot
 *
 * **Written and Scopes follow the FULL selection** — scope + range + every
 * dimension filter. `ExplorerStats` sends the filter bar to `/activity` via
 * `filtersToQueryParams` (the same translation the list uses), and migration
 * 00062 applies it in the RPC, so these two cards count exactly the list's set.
 * There is no disclaimer, because there is nothing to disclaim.
 *
 * Two cards can only go part-way, and each says so in its own caption/tooltip:
 *
 * - **Read follows scope + range, not the filter bar.** `usage_events` records a
 *   read's scope (00058) but not the tags/repo of the memories it returned, so a
 *   dimension filter is unanswerable for reads — the Read card stays scope-level.
 * - **Expired is account-wide.** `usage_events` carries no scope on the expiry
 *   event, because the purge is per-user and spans scopes. Its tooltip says so
 *   and its caption drops the scope name.
 */

import { useMemo } from 'react';
import { BookOpen, BookOpenCheck, Hourglass, Layers } from 'lucide-react';
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
import { filtersToQueryParams, requireField, type Filter } from '@/lib/filters';

/**
 * Shorter labels for the collapsed strip.
 *
 * The card labels are full sentences of a kind ("Memories written") because a
 * card has room and a heading should stand alone. Four of those on one line
 * reads as a paragraph, so the strip leans on the number carrying the emphasis
 * and the word only disambiguating it.
 */
const STRIP_LABELS: Record<string, string> = {
  written: 'written',
  read: 'read',
  scopes: 'scopes',
  expired: 'expired',
};

const sumPoints = (points: { value: number }[]) => points.reduce((total, p) => total + p.value, 0);

/**
 * A last-resort grid, and — like `statsWindow`'s empty-window arm — one nothing
 * reaches today. `bucketPlanForRange` is called with `shown`, which is
 * `effectiveStatsRange`'s output, so an unbounded or unparseable selection has
 * ALREADY been substituted for the bounded `90d` default and charts 90 days,
 * not these 30 daily buckets. It stays as the same 30-day grid the Overview
 * uses so that if the preset table ever stops resolving, a bad link degrades to
 * a page that renders rather than a broken one.
 */
const FALLBACK_PLAN = RANGE_BUCKETS['30d'];

interface ExplorerStatsProps {
  /** The selected scope, or null for all scopes. */
  scope: string | null;
  /**
   * The Explorer's active dimension filters. Forwarded to `/activity` so the
   * Written and Scopes cards narrow to the same set the list shows (migration
   * 00062). Read stays scope-level — usage_events has no per-memory dimension —
   * so these do NOT narrow the Read card.
   */
  filters: Filter[];
  /** The Explorer's shared time range. */
  range: TimeRange;
  /** Human label for the selected scope, for captions. */
  scopeLabel: string;
  /**
   * `strip` is the collapsed rendering — the four numbers on one line, nothing
   * else. `cards` is the expanded one. The panel chrome (heading, range picker,
   * disclosure control) belongs to `ExplorerInsights`, which owns both states.
   */
  variant: 'cards' | 'strip';
  /**
   * ONE clock for the whole panel, owned by `ExplorerInsights` and shared by the
   * strip and the cards. Passed in rather than minted per instance so both
   * renderings resolve the SAME window (and the SAME query key): a per-mount
   * clock would let the strip and the cards fetch different periods, and would
   * remint the key every time the cards mount on expand.
   */
  nowIso: string;
}

export function ExplorerStats({
  scope,
  filters,
  range,
  scopeLabel,
  variant,
  nowIso,
}: ExplorerStatsProps) {
  // Every derivation below hangs off the EFFECTIVE range, never the raw
  // selection: an unbounded selection charts 90 days, so it must also be
  // captioned as 90 days. See `effectiveStatsRange`.
  const shown = useMemo(() => effectiveStatsRange(range, nowIso), [range, nowIso]);
  const plan = useMemo(() => bucketPlanForRange(shown, nowIso) ?? FALLBACK_PLAN, [shown, nowIso]);
  const queryWindow = useMemo(() => statsWindow(shown, nowIso), [shown, nowIso]);

  // The dimension filters as `/activity` query params — the SAME translation the
  // list uses (`filtersToQueryParams`), so the header counts the list's set. Read
  // ignores them (scope-level), applied inside the query for Written/Scopes only.
  const activityFilters = useMemo(() => filtersToQueryParams(filters), [filters]);

  const { data, isLoading, isError, isFetching } = useExplorerStats(
    scope,
    activityFilters,
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

  // A terse naming of the active filters, appended to the captions of the cards
  // that ACTUALLY follow them (Written, Scopes) so the reader can see what the
  // number counts. Read and Expired omit it deliberately — Read is scope-level
  // and Expired account-wide, so showing a filter there would be a lie.
  const filterText = filters.length
    ? ` · ${filters
        .map((f) => {
          const name = requireField(f.field).label.toLowerCase();
          const vals = f.values.join(', ');
          return f.operator === 'nin' ? `${name} not ${vals}` : `${name} ${vals}`;
        })
        .join(' · ')}`
    : '';

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
      description: `in ${rangeText}${scopeText}${filterText}`,
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
      description: `distinct scopes active in ${rangeText}${filterText}`,
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

  if (isError) {
    return (
      <p className="px-4 pb-4 text-sm text-[var(--color-content-secondary)]">
        Failed to load statistics for this selection.
      </p>
    );
  }

  // The held-frame rule, in both renderings: while a new selection loads the
  // PREVIOUS render stays put at reduced opacity instead of collapsing to
  // skeletons. Cards blanking on every scope click reads as the page breaking,
  // and the layout jump loses the reader's place.
  const dim = isFetching || isLoading ? 'opacity-60' : 'opacity-100';

  // ── Collapsed: the numbers, and nothing else ───────────────────────────────
  // Progressive disclosure that SUMMARISES rather than ERASES. The old collapse
  // hid all four figures and left a header saying "Activity", which is the
  // version of this pattern that makes people stop collapsing things: you lose
  // the answer to keep the space. Here the answer stays and only the evidence
  // (trends, bars, the heatmap) folds away.
  if (variant === 'strip') {
    return (
      <dl
        className={`flex flex-wrap items-center gap-x-4 gap-y-1 transition-opacity duration-150 ${dim}`}
        aria-busy={isFetching || isLoading}
      >
        {cards.map(({ id, label, value, icon: Icon }) => (
          <div key={id} className="flex items-center gap-1.5">
            {/* A subtle icon per metric makes the strip scannable — the eye
                finds "written" by its glyph before reading the word. */}
            <Icon className="size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
            {/* `dt` precedes `dd` in the DOM (valid description-list ordering, so
                assistive tech pairs term→value); `order` keeps the number visually
                first. */}
            <dt className="order-3 text-[11px] text-[var(--color-content-tertiary)]">
              {STRIP_LABELS[id] ?? label}
            </dt>
            <dd className="order-2 text-sm font-semibold tabular-nums text-[var(--color-content-primary)]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  // ── Expanded: the evidence behind each number ──────────────────────────────
  return (
    <div
      className={`grid grid-cols-1 gap-3 transition-opacity duration-150 sm:grid-cols-2 lg:grid-cols-4 ${dim}`}
      aria-busy={isFetching || isLoading}
    >
      {cards.map(({ id, ...card }) => (
        <StatCard key={id} {...card} trendTitle={trendTitle} rangeTitle={rangeTitle} />
      ))}
    </div>
  );
}

