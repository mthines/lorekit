import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Lore Explorer' };

export default function LorePage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">
          Lore Explorer
        </h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Browse and manage your agents&apos; lessons by scope.
        </p>
      </div>

      {/* Placeholder — filled in by PR 2 */}
      <div className="flex h-[calc(100vh-12rem)] gap-4">
        <div className="w-64 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
        <div className="flex-1 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
      </div>
    </div>
  );
}
