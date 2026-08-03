'use client';

import { useMemo, useState } from 'react';
import { BookOpen, BookOpenCheck, Info, Layers, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ScopeHealthGrid } from '@/components/dashboard/ScopeHealthCard';
import { Sparkbar } from '@/components/dashboard/Sparkbar';
import { Tooltip } from '@/components/ui/Tooltip';
import { useDashboardData } from '@/lib/queries/dashboard';
import {
  computeCountTrend,
  computeRangeTrends,
  type MetricRange,
  type StatTrend,
} from '@/lib/aggregations';

const RANGE_OPTIONS: { value: MetricRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const RANGE_NOUN: Record<MetricRange, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

function rangeTrendTitle(range: MetricRange): string {
  return `Last ${RANGE_NOUN[range]} vs. previous ${RANGE_NOUN[range]}`;
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
  value: MetricRange;
  onChange: (range: MetricRange) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-0.5"
    >
      {RANGE_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
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
function DashboardStatsSkeleton() {
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
  const [range, setRange] = useState<MetricRange>('24h');

  const rows = data?.rows ?? [];
  const readBuckets = data?.readBuckets ?? [];
  // Injected once per data change so the memoised trend computations stay
  // stable across unrelated re-renders (and remain pure/testable).
  const nowIso = useMemo(() => new Date().toISOString(), [rows]);
  const memoryTrends = useMemo(() => computeRangeTrends(rows, nowIso, range), [rows, nowIso, range]);
  const readTrend = useMemo(
    () => computeCountTrend(readBuckets, nowIso, range),
    [readBuckets, nowIso, range],
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
  const rangeNoun = RANGE_NOUN[range];

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
      description: `in the last ${rangeNoun}`,
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
      description: `in the last ${rangeNoun}`,
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
      description: `distinct scopes active in the last ${rangeNoun}`,
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
                  <TrendChip changePct={trend.changePct} title={rangeTrendTitle(range)} />
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
                ariaLabel={`${label}: last ${rangeNoun}`}
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
