'use client';

import { useMemo } from 'react';
import { BookOpen, BookOpenCheck, Info, Layers, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ScopeHealthGrid } from '@/components/dashboard/ScopeHealthCard';
import { Sparkbar } from '@/components/dashboard/Sparkbar';
import { Tooltip } from '@/components/ui/Tooltip';
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
  isPresetRange,
  rangeLabel,
  resolveRange,
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
 * Nothing about the model blocks it: `{ preset: '90d' }` already resolves.
 */
const RANGE_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

/**
 * Module-level so the reference is stable across renders — `useUrlState`
 * compares against it to decide whether to drop the param from the URL, and a
 * fresh object literal each render would defeat that.
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

/**
 * Small, subtle segmented control for picking the stat row's time range. A
 * single-select radiogroup (aria-checked), sized to sit quietly above the cards
 * without competing with the metrics.
 *
 * There is ONE of these for all three cards: three independent pickers let the
 * row show three different windows at once, which made the cards impossible to
 * read against each other.
 */
function StatRangeSelect({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5"
    >
      {RANGE_OPTIONS.map((opt) => {
        // Compare the PRESET, not the object: `value` is now a discriminated
        // union whose absolute arm ({from,to}) matches no button — which is the
        // correct rendering for a range drilled in from a chart or a deep link,
        // since none of these presets is what the user is looking at.
        const active = isPresetRange(value) && value.preset === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange({ preset: opt.value })}
            className={[
              'min-h-6 rounded px-2 py-0.5 text-[10px] font-medium tabular-nums transition-colors duration-150',
              active
                ? 'bg-[var(--color-bg-raised)] text-[var(--color-content-primary)] shadow-sm'
                : 'text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]',
            ].join(' ')}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The unit a card's number and bars are counted in — "Memory writes",
 * "Memory reads", "Scopes writes".
 *
 * Two of the three cards count memories and one counts scopes, and the
 * difference used to be invisible: the old "Active" card showed a scope count
 * over a chart of memories. A muted pill next to the icon makes the unit
 * unmissable without competing with the metric. Each tag names BOTH the thing
 * counted and the verb, because "writes" alone does not say writes of what —
 * and the Scopes card counts scopes written to, not memories.
 */
function UnitTag({ label }: { label: string }) {
  return (
    <span className="rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
      {label}
    </span>
  );
}

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

/** Period-over-period percentage-change chip. */
function TrendChip({ changePct, title }: { changePct: number; title: string }) {
  const dir = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  const color =
    dir === 'up'
      ? 'text-[var(--color-success)]'
      : dir === 'down'
        ? 'text-[var(--color-error)]'
        : 'text-[var(--color-content-tertiary)]';

  return (
    <span
      className={`flex items-center gap-1 text-xs font-medium tabular-nums ${color}`}
      title={title}
    >
      <Icon className="size-3.5" aria-hidden />
      {changePct > 0 ? `+${changePct}` : changePct}%
    </span>
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
  const gridNowIso = useMemo(() => {
    if (range === null || isPresetRange(range)) return nowIso;
    const window = resolveRange(range, nowIso);
    return window === null ? nowIso : new Date(Date.parse(window.to) - 1).toISOString();
  }, [range, nowIso]);
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
  // One phrase for every card's caption and aria label, derived from the same
  // range the grid was, so a drilled-in window reads as its dates rather than
  // as a preset it is not.
  const rangeText = rangeLabel(range, nowIso).toLowerCase();

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
      description: `in the ${rangeText}`,
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
      description: `in the ${rangeText}`,
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
      description: `distinct scopes active in the ${rangeText}`,
      trend: memoryTrends.newScopes,
      unit: 'scopes',
    },
  ];

  return (
    <>
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-[var(--color-content-tertiary)]">Activity</p>
          <StatRangeSelect value={range} onChange={setRange} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cards.map(({ id, icon: Icon, label, tag, tooltip, value, description, trend, unit }) => (
            <div
              key={id}
              className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                    <Icon className="size-4 text-[var(--color-accent)]" aria-hidden />
                  </div>
                  <UnitTag label={tag} />
                </div>
                {trend.points.length >= 2 && (
                  <TrendChip changePct={trend.changePct} title={rangeTrendTitle(range, nowIso)} />
                )}
              </div>
              <div>
                <p className="text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
                  {value}
                </p>
                <p className="flex items-center gap-1 text-xs text-[var(--color-content-tertiary)]">
                  {label}
                  <Tooltip content={tooltip} side="top" align="center">
                    <Info
                      className="size-3 shrink-0 text-[var(--color-content-tertiary)] opacity-60"
                      aria-hidden
                    />
                  </Tooltip>
                </p>
                <p className="mt-0.5 text-[10px] text-[var(--color-content-tertiary)] opacity-70">
                  {description}
                </p>
              </div>
              {/* Per-metric trend — hover (desktop) or tap (mobile) a bar for values. */}
              <Sparkbar
                points={trend.points}
                unit={unit}
                className="mt-auto h-7 w-full"
                ariaLabel={`${label}: ${rangeText}`}
              />
            </div>
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
