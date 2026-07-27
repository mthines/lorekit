import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Offline storage — Tutorials' };

export default function OfflineTutorialPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-content-primary)]">Offline storage</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Store lore locally on your machine — no account, no network, full privacy.
        </p>
      </div>
      <p className="text-sm text-[var(--color-content-tertiary)]">Coming soon.</p>
    </div>
  );
}
