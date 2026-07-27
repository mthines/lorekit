import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Remote storage — Tutorials' };

export default function RemoteTutorialPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-content-primary)]">Remote storage</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Sync lore to the hosted LoreKit server — access it from any machine, any agent.
        </p>
      </div>
      <p className="text-sm text-[var(--color-content-tertiary)]">Coming soon.</p>
    </div>
  );
}
