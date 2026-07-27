'use client';

import { BookOpen, Info, Layers, Zap, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ScopeHealthGrid } from '@/components/dashboard/ScopeHealthCard';
import { Sparkbar } from '@/components/dashboard/Sparkbar';
import { Tooltip } from '@/components/ui/Tooltip';
import { useDashboardData } from '@/lib/queries/dashboard';

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
 */
export function DashboardStats() {
  const { data, isLoading, isError } = useDashboardData();

  if (isLoading) return <DashboardStatsSkeleton />;

  if (isError || !data) {
    return (
      <p className="text-sm text-[var(--color-content-secondary)]">
        Failed to load scope data. Please refresh the page.
      </p>
    );
  }

  const { scopes, totalLessons, trends } = data;
  // Rolling 24-hour window (not calendar day) — more relevant than "since
  // midnight", which resets to 0 every night regardless of recent activity.
  const dayAgo = Date.now() - 86_400_000;
  const active24h = scopes.filter(
    (s) => s.lastActivity != null && new Date(s.lastActivity).getTime() >= dayAgo,
  ).length;

  const stats = [
    {
      icon: BookOpen,
      label: 'Total lessons',
      tooltip: 'Total number of lessons stored across all scopes, based on the most recent 1,000 rows fetched. The trend chip shows the change in lessons written in the last 7 days vs. the prior 7 days.',
      value: totalLessons,
      description: 'across all scopes',
      trend: trends.lessons,
      showTrend: true,
      unit: 'lessons',
      trendTitle: 'Last 7 days vs. previous 7',
    },
    {
      icon: Layers,
      label: 'Scopes · 7d',
      tooltip: 'Number of distinct memory scopes (namespaces) that had at least one lesson written in the last 7 days. The trend chip compares this week\'s unique scope count to the prior week\'s — useful for spotting whether your agents are exploring new areas or narrowing focus.',
      value: trends.activeScopes7d,
      description: 'distinct scopes active this week',
      trend: trends.scopes,
      showTrend: true,
      unit: 'scopes',
      trendTitle: 'Last 7 days vs. previous 7',
    },
    {
      icon: Zap,
      label: 'Active · 24h',
      tooltip: 'Number of distinct scopes that had at least one lesson written in the last 24 hours (rolling window, not since midnight). The bar chart below shows hourly lesson volume across the same 24-hour period.',
      value: active24h,
      description: 'scopes written in the last 24h',
      trend: trends.activity,
      showTrend: false,
      unit: 'lessons',
      trendTitle: 'Last 12 hours vs. previous 12',
    },
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map(({ icon: Icon, label, tooltip, value, description, trend, showTrend, unit, trendTitle }) => (
          <div
            key={label}
            className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
                <Icon className="size-4 text-[var(--color-accent)]" aria-hidden />
              </div>
              {showTrend && trend.points.length >= 2 && (
                <TrendChip changePct={trend.changePct} title={trendTitle} />
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
              ariaLabel={`${label}: recent trend`}
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
