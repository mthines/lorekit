import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Tags & scopes — Tutorials' };

export default function TagsTutorialPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-content-primary)]">Tags & scopes</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Organise lore with tags and scope namespaces — find the right lesson at the right time.
        </p>
      </div>
      <p className="text-sm text-[var(--color-content-tertiary)]">Coming soon.</p>
    </div>
  );
}
