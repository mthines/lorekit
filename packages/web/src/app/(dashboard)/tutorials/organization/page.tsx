import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Team sharing — Tutorials' };

export default function OrganizationTutorialPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-content-primary)]">Team sharing</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Create an org, invite teammates, and share lore across a whole team.
        </p>
      </div>
      <p className="text-sm text-[var(--color-content-tertiary)]">Coming soon.</p>
    </div>
  );
}
