import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Activity' };

export default function ActivityPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Activity
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          What your agents have been learning, day by day.
        </p>
      </div>

      {/* Placeholder — filled in by PR 3 */}
      <div className="flex flex-col gap-4">
        <div className="h-36 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
