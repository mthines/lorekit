'use client';

import { useMemo, useState } from 'react';
import { BookOpen, Info, Layers, Zap, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ScopeHealthGrid } from '@/components/dashboard/ScopeHealthCard';
import { Sparkbar } from '@/components/dashboard/Sparkbar';
import { Tooltip } from '@/components/ui/Tooltip';
import { useDashboardData } from '@/lib/queries/dashboard';
import { computeRangeTrends, type MetricRange, type StatTrend } from '@/lib/aggregations';

type CardId = 'total' | 'scopes' | 'active';

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

/** Per-card default range — first two stat cards default to 7d, "Active" to 24h. */
const DEFAULT_RANGES: Record<CardId, MetricRange> = {
  total: '7d',
  scopes: '7d',
  active: '24h',
};

function rangeTrendTitle(range: MetricRange): string {
  return `Last ${RANGE_NOUN[range]} vs. previous ${RANGE_NOUN[range]}`;
}

/**
 * Small, subtle segmented control for picking a stat card's time range. A
 * single-select radiogroup (aria-checked), sized to sit quietly in the card
 * header without competing with the metric.
 */
function StatRangeSelect({
  value,
  onChange,
  label,
}: {
  value: MetricRange;
  onChange: (range: MetricRange) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`Time range for ${label}`}
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
              'rounded px-2 py-1 text-[11px] font-medium tabular-nums transition-colors duration-150',
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

/** Skeleton that matches the real layout to prevent CLS while the query loads. */
function DashboardStatsSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
          />
        ))}
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
 * Client component — fetches scope health and lesson stats via TanStack Query.
 * Renders inline skeletons while loading so the surrounding RSC content
 * (header, onboarding checklist) appears immediately.
 *
 * Each stat card owns a time-range selector (24h / 7d / 30d). The selected range
 * drives BOTH the sparkbar buckets and the trend chip, so the chart and the
 * trend always describe the same period. Trends are recomputed client-side from
 * the raw rows, so switching a range never refetches.
 */
export function DashboardStats() {
  const { data, isLoading, isError } = useDashboardData();
  const [ranges, setRanges] = useState<Record<CardId, MetricRange>>(DEFAULT_RANGES);

  const rows = data?.rows ?? [];
  // Injected once per data change so the three memoised trend computations stay
  // stable across unrelated re-renders (and remain pure/testable).
  const nowIso = useMemo(() => new Date().toISOString(), [rows]);
  const totalTrends = useMemo(() => computeRangeTrends(rows, nowIso, ranges.total), [rows, nowIso, ranges.total]);
  const scopeTrends = useMemo(() => computeRangeTrends(rows, nowIso, ranges.scopes), [rows, nowIso, ranges.scopes]);
  const activeTrends = useMemo(() => computeRangeTrends(rows, nowIso, ranges.active), [rows, nowIso, ranges.active]);

  if (isLoading) return <DashboardStatsSkeleton />;

  if (isError || !data) {
    return (
      <p className="text-sm text-[var(--color-content-secondary)]">
        Failed to load scope data. Please refresh the page.
      </p>
    );
  }

  const { scopes, totalLessons } = data;

  const cards: {
    id: CardId;
    icon: typeof BookOpen;
    label: string;
    tooltip: string;
    value: number;
    description: string;
    trend: StatTrend;
    showTrend: boolean;
    unit: string;
    range: MetricRange;
  }[] = [
    {
      id: 'total',
      icon: BookOpen,
      label: 'Total memories',
      tooltip:
        'Total number of memories stored across all scopes, based on the most recent 1,000 rows fetched. Use the range selector to view memories written over the last 24 hours, 7 days, or 30 days — the sparkbar and the trend chip always cover the same period.',
      value: totalLessons,
      description: 'across all scopes',
      trend: totalTrends.lessons,
      showTrend: true,
      unit: 'memories',
      range: ranges.total,
    },
    {
      id: 'scopes',
      icon: Layers,
      label: 'Scopes',
      tooltip:
        'Distinct memory scopes (namespaces) with at least one memory written in the selected range. The trend chip compares this window against the preceding one — useful for spotting whether your agents are exploring new areas or narrowing focus.',
      value: scopeTrends.activeScopes,
      description: `distinct scopes active in the last ${RANGE_NOUN[ranges.scopes]}`,
      trend: scopeTrends.scopes,
      showTrend: true,
      unit: 'scopes',
      range: ranges.scopes,
    },
    {
      id: 'active',
      icon: Zap,
      label: 'Active',
      tooltip:
        'Distinct scopes with at least one memory written in the selected range (rolling window). The bar chart shows memory volume across the same period.',
      value: activeTrends.activeScopes,
      description: `scopes active in the last ${RANGE_NOUN[ranges.active]}`,
      trend: activeTrends.lessons,
      showTrend: false,
      unit: 'memories',
      range: ranges.active,
    },
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {cards.map(({ id, icon: Icon, label, tooltip, value, description, trend, showTrend, unit, range }) => (
          <div
            key={id}
            className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                <Icon className="size-4 text-[var(--color-accent)]" aria-hidden />
              </div>
              <div className="flex items-center gap-2">
                <StatRangeSelect
                  value={range}
                  label={label}
                  onChange={(next) => setRanges((prev) => ({ ...prev, [id]: next }))}
                />
                {showTrend && trend.points.length >= 2 && (
                  <TrendChip changePct={trend.changePct} title={rangeTrendTitle(range)} />
                )}
              </div>
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
              ariaLabel={`${label}: last ${RANGE_NOUN[range]}`}
            />
          </div>
        ))}
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
