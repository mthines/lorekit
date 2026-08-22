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
 * **Written and Scopes follow the scope, range, and every DIMENSION filter** —
 * `ExplorerStats` sends the filter bar to `/activity` via `filtersToActivityBody`
 * (the same translation the list uses), and migration 00063 applies it in the
 * RPC, so these two cards count exactly the list's set for that slice.
 *
 * Two page-level controls are deliberately NOT forwarded, so under either the
 * header describes the ACTIVE, unsearched set while the list may show more or
 * less: the `status` control (Archived / Expiring selects a different
 * population, and the activity RPC only ever counts active, non-expired rows),
 * and the free-text `q` search (the RPC has no full-text arm). Both are stated
 * here rather than silently implied to be counted; forwarding them to the RPC is
 * a tracked follow-up. The dimension filters, which is what people reach for to
 * narrow a scope, ARE reflected, so there is no per-card disclaimer for them.
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
import { Archive, BookOpen, BookOpenCheck, Layers } from 'lucide-react';
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
import { filtersToActivityBody, requireField, type Filter } from '@/lib/filters';

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
   * 00063). Read stays scope-level — usage_events has no per-memory dimension —
   * so these do NOT narrow the Read card.
   */
  filters: Filter[];
  /** The Explorer's shared time range. */
  range: TimeRange;
  /** Human label for the selected scope, for captions. */
  scopeLabel: string;
  /**
   * Whether the cards show their evidence, owned by `ExplorerInsights`. This is
   * ONE persistent grid of cards at two densities, not two renderings that swap:
   * when `false` each card keeps its icon, number, label and caption and only
   * folds away the evidence (trend chip + sparkbar); when `true` the evidence
   * unfolds. Passing the flag down rather than mounting a different subtree is
   * what lets the expand read as one motion instead of a cross-fade.
   *
   * It is the panel being OPEN *and* on its `charts` view — on `heatmap` the
   * cards are the compact summary the calendar is read against, so they stay
   * folded even though the panel is open.
   */
  expanded: boolean;
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
  expanded,
  nowIso,
}: ExplorerStatsProps) {
  // Every derivation below hangs off the EFFECTIVE range, never the raw
  // selection: an unbounded selection charts 90 days, so it must also be
  // captioned as 90 days. See `effectiveStatsRange`.
  const shown = useMemo(() => effectiveStatsRange(range, nowIso), [range, nowIso]);
  const plan = useMemo(() => bucketPlanForRange(shown, nowIso) ?? FALLBACK_PLAN, [shown, nowIso]);
  const queryWindow = useMemo(() => statsWindow(shown, nowIso), [shown, nowIso]);

  // The dimension filters as the `POST /activity` request BODY — the SAME
  // translation the list uses (`filtersToActivityBody`), so the header counts the
  // list's set. Read ignores them (scope-level), applied inside the query for
  // Written/Scopes only.
  const activityFilters = useMemo(() => filtersToActivityBody(filters), [filters]);

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
      // Archived: memories a caller archived in the range. This is the one
      // countable lifecycle metric — it is a caller ACTION, recorded as an
      // event. Expiry is deliberately NOT shown here: the product expires memories
      // ON READ (a read filters an expired row out; `list.ts`), so there is no
      // expiry EVENT to count and no purge runs — the figure would be a
      // structural zero. Soon-to-expire memories are surfaced where they are
      // actionable instead: the list's "Expiring" status filter.
      id: 'archived',
      icon: Archive,
      label: 'Memories archived',
      tag: 'Archived',
      tooltip:
        'Memories archived by a caller in the selected range. ACCOUNT-WIDE even when a scope is selected — archiving is recorded per user, so the event carries no scope to filter on. (Expired memories are hidden on read rather than counted here; find soon-to-expire ones via the Expiring status filter.)',
      value: data?.archived ?? 0,
      // No scope suffix, deliberately — see the tooltip.
      description: `across your account in ${rangeText}`,
      // No series today: the usage endpoint reports this as a total with no
      // per-bucket breakdown, so there is nothing honest to draw yet.
    },
  ];

  if (isError) {
    return (
      <p className="px-4 pb-4 text-sm text-[var(--color-content-secondary)]">
        Failed to load statistics for this selection.
      </p>
    );
  }

  // The held-frame rule: while a new selection loads the PREVIOUS render stays
  // put at reduced opacity instead of collapsing to skeletons. Cards blanking on
  // every scope click reads as the page breaking, and the layout jump loses the
  // reader's place.
  const dim = isFetching || isLoading ? 'opacity-60' : 'opacity-100';

  // ── One grid at two densities ──────────────────────────────────────────────
  // The same four cards are ALWAYS mounted; `collapsed` folds each card's
  // evidence (trend chip + sparkbar) away without unmounting the card, so
  // expanding reads as one motion — the answer stays put and only the evidence
  // unfolds — rather than a strip cross-fading into a different set of cards.
  //
  // Columns key off the PANEL's own width (`@3xl` against the `@container` on the
  // insights `<section>`), not the viewport. A viewport breakpoint
  // (`md:grid-cols-4`) can't see that the panel is narrower than the screen — the
  // sidebar eats width, and a narrow embed is narrower still — so it packed four
  // full cards into a ~370px column. Sized to the panel, the grid goes four-up
  // only once the panel can seat four cards and their sparkbars without cramping
  // (~768px), and stays two-up below that.
  // Columns key off the panel's width AND its density. A COLLAPSED card is a
  // number with a label under it, so it seats two-up even on the narrowest phone
  // — which is the whole point of the folded state: a summary LINE, not a screen
  // of four stacked tiles. Four one-up cards ran to about half a phone's viewport;
  // two-up at the tighter collapsed padding is roughly a quarter of it.
  //
  // Expanded, each card carries a full-width sparkbar and its caption, so the
  // one-up arm below ~384px comes back — two of those side by side crush the
  // number, which is what that breakpoint was always for.
  const columns = expanded
    ? 'grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-4'
    : 'grid-cols-2 gap-2 @3xl:grid-cols-4';

  return (
    <div
      className={`grid transition-opacity duration-150 ${columns} ${dim}`}
      aria-busy={isFetching || isLoading}
    >
      {cards.map(({ id, ...card }) => (
        <StatCard
          key={id}
          {...card}
          trendTitle={trendTitle}
          rangeTitle={rangeTitle}
          collapsible
          collapsed={!expanded}
        />
      ))}
    </div>
  );
}

