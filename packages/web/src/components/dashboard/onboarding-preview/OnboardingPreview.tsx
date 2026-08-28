'use client';

/**
 * Resolver for `new-onboarding-flow` — the ONLY file that changes when the
 * experiment ends. Copy-and-suffix convention: each arm is its own component
 * in its own file (`.control.tsx` / `.treatment.tsx`), never a branch inside
 * one shared component. See `packages/feature-flags/CLAUDE.md` § "UI
 * variants: copy-and-suffix, never inline branching" for the full rationale
 * and the removal procedure.
 *
 * Rendered on the Developer settings page (`/settings/developer`) as a live
 * preview of both arms — not (yet) wired into the real onboarding flow;
 * see `docs/feature-flags.md` for the worked-example scope note.
 */
import { useFeatureFlagVariant } from '@/components/providers/FeatureFlagsProvider';
import { OnboardingPreviewControl } from './OnboardingPreview.control';
import { OnboardingPreviewTreatment } from './OnboardingPreview.treatment';

export function OnboardingPreview() {
  const variant = useFeatureFlagVariant('new-onboarding-flow');

  switch (variant) {
    case 'treatment':
      return <OnboardingPreviewTreatment />;
    case 'control':
    default:
      // `default` covers a session override naming a variant this switch
      // predates, or a registry variant this resolver hasn't been updated
      // for yet — falls back to the always-safe arm rather than rendering
      // nothing.
      return <OnboardingPreviewControl />;
  }
}
