'use client';

import { ScopeHealthGrid } from '@/components/dashboard/ScopeHealthCard';
import { useDashboardData } from '@/lib/queries/dashboard';

/** Skeleton that matches the real layout to prevent CLS while the query loads. */
function DashboardStatsSkeleton() {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
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

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: 'Total lessons', value: totalLessons },
          { label: 'Scopes', value: scopes.length },
          {
            label: 'Active today',
            value: scopes.filter((s) =>
              s.lastActivity?.startsWith(new Date().toISOString().slice(0, 10)),
            ).length,
          },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
          >
            <p className="text-xs text-[var(--color-content-tertiary)]">{label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--color-content-primary)]">
              {value}
            </p>
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
