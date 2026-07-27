import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Use cases — Tutorials' };

export default function UseCasesTutorialPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-content-primary)]">Use cases</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          End-to-end examples: autonomous workflows, multi-agent memory, CI/CD integration, and more.
        </p>
      </div>
      <p className="text-sm text-[var(--color-content-tertiary)]">Coming soon.</p>
    </div>
  );
}
