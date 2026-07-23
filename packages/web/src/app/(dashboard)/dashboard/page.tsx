import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Overview
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Your agents&apos; accumulated knowledge at a glance.
        </p>
      </div>

      {/* Placeholder — filled in by PR 4 (Scope Health Scorecard + Onboarding) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
          />
        ))}
      </div>
    </div>
  );
}
