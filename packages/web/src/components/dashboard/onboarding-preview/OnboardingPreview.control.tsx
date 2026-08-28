/**
 * The "control" arm of `new-onboarding-flow` — the existing three-step flow.
 * Deliberately a WHOLE, standalone component: it shares nothing with
 * `.treatment.tsx`, so a decision to keep this arm is "delete the sibling
 * file and the resolver's switch case," never a diff inside this file.
 * See `../OnboardingPreview.tsx` (the resolver) and
 * `packages/feature-flags/CLAUDE.md` § "UI variants".
 */
export function OnboardingPreviewControl() {
  return (
    <ol className="list-inside list-decimal space-y-1 text-sm text-[var(--color-content-secondary)]">
      <li>Install the CLI</li>
      <li>Connect your MCP client</li>
      <li>Write your first lesson</li>
    </ol>
  );
}
