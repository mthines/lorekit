/**
 * The "treatment" arm of `new-onboarding-flow` — the single-page wizard being
 * tested against `.control.tsx`. A whole, standalone component on purpose —
 * see the note in `.control.tsx` and `../OnboardingPreview.tsx` (the resolver).
 */
export function OnboardingPreviewTreatment() {
  return (
    <div className="rounded-md border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] p-3">
      <p className="text-sm font-medium text-[var(--color-content-primary)]">
        One page. Paste your MCP config, install the CLI, and write your first lesson —
        all inline, no wizard steps.
      </p>
    </div>
  );
}
