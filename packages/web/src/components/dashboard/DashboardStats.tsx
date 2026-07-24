'use client';

import { BookOpen, Layers, Zap } from 'lucide-react';
import { ScopeHealthGrid } from '@/components/dashboard/ScopeHealthCard';
import { useDashboardData } from '@/lib/queries/dashboard';

/** Skeleton that matches the real layout to prevent CLS while the query loads. */
function DashboardStatsSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
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

  const { scopes, totalLessons } = data;
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const activeToday = scopes.filter((s) => s.lastActivity?.startsWith(todayPrefix)).length;

  const stats = [
    {
      icon: BookOpen,
      label: 'Total lessons',
      value: totalLessons,
      description: 'across all scopes',
    },
    {
      icon: Layers,
      label: 'Scopes',
      value: scopes.length,
      description: 'active memory namespaces',
    },
    {
      icon: Zap,
      label: 'Active today',
      value: activeToday,
      description: 'scopes with new writes',
    },
  ];

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map(({ icon: Icon, label, value, description }) => (
          <div
            key={label}
            className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5"
          >
            <div className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
              <Icon className="size-4 text-[var(--color-accent)]" aria-hidden />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
                {value}
              </p>
              <p className="text-xs text-[var(--color-content-tertiary)]">{label}</p>
              <p className="mt-0.5 text-[10px] text-[var(--color-content-tertiary)] opacity-70">
                {description}
              </p>
            </div>
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
