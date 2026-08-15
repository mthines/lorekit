'use client';

import { useMemo } from 'react';
import { BookOpen, BookOpenCheck, Layers } from 'lucide-react';
import { ScopeHealthGrid } from '@/components/dashboard/ScopeHealthCard';
import { StatCard } from '@/components/dashboard/StatCard';
import { RangePicker } from '@/components/ui/RangePicker';
import { useUrlState } from '@/lib/hooks/useUrlState';
import { useDashboardData } from '@/lib/queries/dashboard';
import {
  computeCountTrend,
  computeRangeTrends,
  RANGE_BUCKETS,
  type StatTrend,
} from '@/lib/aggregations';
import {
  bucketPlanForRange,
  gridAnchor,
  rangeCaption,
  rangeLabel,
  type RangePreset,
  type TimeRange,
} from '@/lib/time-range';

/**
 * The presets this row offers.
 *
 * `all` is deliberately absent, and not as an oversight: every card here shows a
 * period-over-period `changePct`, which needs a PRECEDING window of equal length
 * to compare against — and "all time" has no preceding window. The Explorer,
 * which lists rather than trends, does offer it (`?range` absent).
 *
 * The set is deliberately UNCHANGED by this PR, even though the shared model now
 * understands `90d` too (`RANGE_PRESETS`). This is a refactor of what the
 * selection MEANS, not of what the control offers, and the committed visual
 * baselines (`__screenshots__/DashboardStats.stories.tsx`) pin this row pixel for
 * pixel — a fourth button is a baseline regeneration, which belongs with the
 * stats-header work that redesigns this control rather than smuggled in here.
 *
 * The MODEL does not block a fourth button — `{ preset: '90d' }` already
 * resolves — but the DATA would, and that is the larger of the two reasons.
 * `useDashboardData` fetches `TREND_WINDOW_DAYS = 62` days
 * (`lib/queries/dashboard.ts`), sized as the widest preset here plus the equal
 * preceding window every card compares against, plus slack. A `90d` selection
 * charts 90 daily buckets over 62 days of data, and its comparison half is
 * entirely outside the fetch — so the trend chip reads `+100%` by construction.
 * Offering `90d` means widening that fetch to ~182 days, tripling the activity
 * payload on every Overview load; widen-vs-clamp-vs-drop is a product call this
 * refactor deliberately does not make. Until it is made, a hand-edited
 * `?range={"preset":"90d"}` on this page is bounded by the same 62 days.
 */
const OVERVIEW_PRESETS: readonly RangePreset[] = ['24h', '7d', '30d'];

/**
 * Module-level so the reference is stable across renders.
 *
 * Not for the URL's sake: `buildUrl` decides whether to drop the param by JSON
 * equality (`serialise(next) === serialise(defaultValue)`), so a fresh literal
 * would still be recognised as the default and still be dropped. It is the
 * HOOK's identities that need it — `defaultValue` sits in `setState`'s
 * `useCallback` deps and in the `cleanOnPathname` effect's deps, and the
 * `urlValue` memo deliberately omits it while documenting that "callers are
 * expected to pass a stable reference". A new object every render would remint
 * the setter and re-run that effect on every render.
 *
 * The default is a PRESET rather than a resolved window, so an Overview with no
 * `?range=` in the URL keeps asking "the last 24 hours" every time it is opened
 * instead of pinning the day it was first loaded.
 */
const DEFAULT_OVERVIEW_RANGE: TimeRange = { preset: '24h' };

/**
 * The grid to fall back on when the selected range has none — i.e. `all`, or a
 * malformed `?range=` from a hand-edited URL. 30 daily buckets is the widest
 * preset that still charts legibly; the alternative, rendering nothing, would
 * turn a bad link into a broken page.
 */
const FALLBACK_PLAN = RANGE_BUCKETS['30d'];

/**
 * The trend chip's tooltip: what this window is being compared against.
 *
 * There is only ONE comparison rule — the immediately preceding window of the
 * same length — so there is only one sentence for a bounded range. The branch
 * this replaced offered "previous" and "preceding" as if they were different
 * comparisons, and its unbounded arm read "All time vs. the preceding period of
 * the same length", naming a period that cannot exist.
 *
 * An unbounded range has no grid of its own, so the cards fall back to
 * {@link FALLBACK_PLAN} — the tooltip names THAT window rather than the
 * selection, because the fallback grid is what the bars and the chip actually
 * describe.
 */
function rangeTrendTitle(range: TimeRange, nowIso: string): string {
  if (bucketPlanForRange(range, nowIso) === null) {
    const period = `${FALLBACK_PLAN.count} ${FALLBACK_PLAN.unit}s`;
    return `The last ${period} vs. the preceding ${period}`;
  }
  return `${rangeLabel(range, nowIso)} vs. the preceding period of the same length`;
}

const sumPoints = (points: { value: number }[]) => points.reduce((total, p) => total + p.value, 0);

/** Skeleton that matches the real layout to prevent CLS while the query loads. */
export function DashboardStatsSkeleton() {
  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
          <div className="h-6 w-28 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
            />
          ))}
        </div>
      </div>
      <div>
        <div className="mb-3 h-3 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
            />
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * Client component — fetches scope health, write activity and read activity via
 * TanStack Query. Renders inline skeletons while loading so the surrounding RSC
 * content (header, onboarding checklist) appears immediately.
 *
 * ONE range picker (24h / 7d / 30d, default 24h) drives all three cards, so the
 * row always describes a single window. Everything is recomputed client-side
 * from data fetched once over the widest window, so switching the range never
 * refetches.
 *
 * **Every card is additive: summing its bars reproduces its headline number.**
 * That is the property the cards are built around, and it is why the Scopes
 * card charts NEW scopes per bucket rather than distinct-per-bucket (a scope
 * active on three days is one unit of the total, so it must contribute one
 * bar), and why the read card counts RECORDS read rather than read calls.
 */
export function DashboardStats() {
  const { data, isLoading, isError } = useDashboardData();
  // URL-backed, and the SAME `range` param the Explorer reads. That is the point
  // of the shared model: a KPI here can deep-link into a pre-filtered Explorer
  // (PR-9) without translating between two vocabularies, and a range chosen on
  // either page means the same thing on the other. It also makes the selection
  // shareable, which local state never was.
  const [range, setRange] = useUrlState<TimeRange>('range', DEFAULT_OVERVIEW_RANGE);

  const rows = data?.rows ?? [];
  const readBuckets = data?.readBuckets ?? [];
  // Injected once per data change so the memoised trend computations stay
  // stable across unrelated re-renders (and remain pure/testable).
  const nowIso = useMemo(() => new Date().toISOString(), [rows]);
  // The window → grid step. `bucketPlanForRange` returns null for an unbounded
  // or unparseable range, which the cards cannot chart — see FALLBACK_PLAN.
  const plan = useMemo(() => bucketPlanForRange(range, nowIso) ?? FALLBACK_PLAN, [range, nowIso]);
  // A plan is only `{unit, count}` — it says how WIDE the grid is, never where
  // it sits — and both aggregators anchor their grid at the clock. For a preset
  // that is exactly right ("the last 7 days" ends now), but for an ABSOLUTE
  // window it charted the most recent `count` buckets while the caption named
  // the selected dates: pick last July and you got this week's bars under a
  // "Jul 1 – Jul 3" label. So an absolute arm anchors the grid at its OWN end
  // instead. The `to` bound is EXCLUSIVE, hence the step back to the last
  // instant inside the window — anchoring at `to` itself would shift the whole
  // chart one bucket into the future and drop the window's first bucket.
  //
  // A preset and an unbounded range still anchor at `nowIso`, unchanged: that
  // is what they mean, and it keeps every existing render identical.
  // Extracted to `lib/time-range.ts` now that the Explorer's stats header needs
  // the identical rule — the rule is invisible when wrong (both charts still
  // render, they just describe a period nobody selected), which is the worst
  // kind of thing to keep two copies of.
  const gridNowIso = useMemo(() => gridAnchor(range, nowIso), [range, nowIso]);
  const memoryTrends = useMemo(
    () => computeRangeTrends(rows, gridNowIso, plan),
    [rows, gridNowIso, plan],
  );
  const readTrend = useMemo(
    () => computeCountTrend(readBuckets, gridNowIso, plan),
    [readBuckets, gridNowIso, plan],
  );

  if (isLoading) return <DashboardStatsSkeleton />;

  if (isError || !data) {
    return (
      <p className="text-sm text-[var(--color-content-secondary)]">
        Failed to load scope data. Please refresh the page.
      </p>
    );
  }

  const { scopes } = data;
  // One phrase for every card's caption, derived from the same range the grid
  // was, so a drilled-in window reads as its dates rather than as a preset it is
  // not. `rangeCaption` (not `rangeLabel().toLowerCase()`) because only a preset
  // is prose: lowercasing the absolute arm turned "Jul 1 – Jul 3" into a date
  // nobody writes, and it supplies its own article, so the sites below say
  // "in ${…}" rather than "in the ${…}".
  const rangeText = rangeCaption(range, nowIso);
  // The aria label wants the TITLE, not the caption fragment — a screen reader
  // hears it after the card's name, where "Last 24 hours" reads better than the
  // article-carrying "the last 24 hours".
  const rangeTitle = rangeLabel(range, nowIso);

  // Order: the two memory-count cards sit together (written, then read) so the
  // reader compares like with like, and the scope-breadth card — the only one
  // counting something other than memories — comes last.
  const cards: {
    id: string;
    icon: typeof BookOpen;
    label: string;
    tag: string;
    tooltip: string;
    value: number;
    description: string;
    trend: StatTrend;
    unit: string;
  }[] = [
    {
      id: 'written',
      icon: BookOpen,
      label: 'Memories written',
      tag: 'Memory writes',
      tooltip:
        'New memories written across all scopes in the selected range. The bars sum to the number: each bar is the memories written in that hour or day. The trend chip compares this window against the preceding one. Your all-time total across every scope is shown in the memory badge at the top right.',
      value: sumPoints(memoryTrends.lessons.points),
      description: `in ${rangeText}`,
      trend: memoryTrends.lessons,
      unit: 'memories',
    },
    {
      id: 'read',
      icon: BookOpenCheck,
      label: 'Memories read',
      tag: 'Memory reads',
      tooltip:
        'Memory records read in the selected range by your agents and tools, across the MCP tools and the REST API — one list call returning 20 memories counts as 20 records, not one read. Browsing your lore in this dashboard does NOT count: reading it here is visualisation, not consumption, so those reads are excluded and reloading a page never moves this number. Unlike the two cards beside it, this counts only YOUR reads: usage is a per-user ledger, so reads by other members of your organization are never included. The bars sum to the number, and the trend chip compares this window against the preceding one.',
      value: sumPoints(readTrend.points),
      description: `in ${rangeText}`,
      trend: readTrend,
      unit: 'memories',
    },
    {
      id: 'scopes',
      icon: Layers,
      label: 'Scopes',
      tag: 'Scopes writes',
      tooltip:
        'Distinct memory scopes (namespaces) with at least one memory written in the selected range. Each bar is the scopes seen for the FIRST time in that hour or day, so the bars sum to the distinct total rather than counting a long-running scope once per bucket. The trend chip compares the distinct scopes of this window against the preceding one.',
      value: memoryTrends.activeScopes,
      description: `distinct scopes active in ${rangeText}`,
      trend: memoryTrends.newScopes,
      unit: 'scopes',
    },
  ];

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-[var(--color-content-tertiary)]">Activity</p>
          {/* The SHARED picker — the Explorer renders the same component, so
              the two pages cannot drift into two ways of choosing a range. */}
          <RangePicker
            value={range}
            onChange={setRange}
            presets={OVERVIEW_PRESETS}
            nowIso={nowIso}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cards.map(({ id, ...card }) => (
            <StatCard
              key={id}
              {...card}
              trendTitle={rangeTrendTitle(range, nowIso)}
              rangeTitle={rangeTitle}
            />
          ))}
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-medium text-[var(--color-content-tertiary)]">
          Scope health · sorted by recent activity
        </p>
        <ScopeHealthGrid scopes={scopes} />
      </div>
    </>
  );
}
