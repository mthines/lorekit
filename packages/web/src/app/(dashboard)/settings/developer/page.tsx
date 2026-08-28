import type { Metadata } from 'next';
import { FlaskConical } from 'lucide-react';
import { FLAG_REGISTRY, evaluateFlagDetails, type FlagKey } from '@lorekit/feature-flags';
import { resolveFeatureFlagContext } from '@/lib/feature-flags/server';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { DeveloperFlagsPanel, type DeveloperFlagRow } from '@/components/settings/DeveloperFlagsPanel';
import { OnboardingPreview } from '@/components/dashboard/onboarding-preview/OnboardingPreview';

export const metadata: Metadata = { title: 'Developer — Settings' };

/**
 * Settings → Developer. Not linked from `SETTINGS_SECTIONS` in production —
 * see `SettingsNav.tsx`'s environment check — because forcing a flag variant
 * is a debugging aid for the team building LoreKit, not a customer-facing
 * setting. The route itself has no additional auth beyond the dashboard
 * layout's own (any signed-in user reaching this URL directly outside
 * production can override their own session's flags); that is an accepted,
 * self-limited blast radius — see `docs/feature-flags.md` §
 * "Session overrides" for the reasoning against a role gate instead.
 */
export default async function DeveloperSettingsPage() {
  const context = await resolveFeatureFlagContext();

  const rows: DeveloperFlagRow[] = await Promise.all(
    FLAG_REGISTRY.map(async (def) => {
      // `FLAG_REGISTRY` entries type `key` as plain `string` (zod-inferred) —
      // `FLAG_KEYS`/`FlagKey` is the generated, narrowed union derived from the
      // SAME registry (see `generated-artifacts.spec.ts`'s freshness guard),
      // so this cast is safe by construction, never by assumption.
      const details = await evaluateFlagDetails(def.key as FlagKey, context);
      return {
        key: def.key,
        description: def.description,
        owner: def.owner,
        tags: def.tags,
        variants: Object.keys(def.variants),
        isExperiment: Boolean(def.experiment?.enabled),
        value: details.value,
        variant: details.variant ?? def.defaultVariant,
        reason: details.reason ?? 'STATIC',
        overrideActive: details.reason === 'OVERRIDE',
      };
    }),
  );

  return (
    <SectionPanel
      icon={<FlaskConical className="size-4.5" />}
      title="Developer"
      subtitle="Force a feature-flag variant for your own session — for both the server and the browser. Resets independently per flag, or all at once."
    >
      <DeveloperFlagsPanel rows={rows} />

      {/*
        Live proof of the copy-and-suffix UI-variant convention
        (packages/feature-flags/CLAUDE.md) — toggle new-onboarding-flow above
        and this re-renders through the SAME resolver/useFeatureFlagVariant
        path a real feature would use. Not (yet) wired into the actual
        onboarding flow — see docs/feature-flags.md for the scope note.
      */}
      <div className="mt-6 border-t border-[var(--color-border)] pt-6">
        <h3 className="text-sm font-medium text-[var(--color-content-primary)]">
          Live variant preview — <code>new-onboarding-flow</code>
        </h3>
        <p className="mt-1 text-xs text-[var(--color-content-secondary)]">
          Renders through <code>OnboardingPreview</code>'s resolver, exactly like a real
          copy-and-suffix component would. Change the override above to see it switch.
        </p>
        <div className="mt-3">
          <OnboardingPreview />
        </div>
      </div>
    </SectionPanel>
  );
}
