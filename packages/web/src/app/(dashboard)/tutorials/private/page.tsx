import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Private lore — Tutorials' };

export default function PrivateTutorialPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-content-primary)]">Private lore</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Keep sensitive lessons personal — understand scope precedence and the personal/org split.
        </p>
      </div>
      <p className="text-sm text-[var(--color-content-tertiary)]">Coming soon.</p>
    </div>
  );
}
