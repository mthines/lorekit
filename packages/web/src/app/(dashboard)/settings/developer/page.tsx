import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { FlaskConical } from 'lucide-react';
import { FLAG_REGISTRY, evaluateFlagDetails, type FlagKey } from '@lorekit/feature-flags';
import { resolveFeatureFlagContext } from '@/lib/feature-flags/server';
import { resolveDeploymentEnvironment } from '@/lib/otel-deployment-env';
import { isDeveloperEmail } from '@/lib/developer-users';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { SectionPanel } from '@/components/ui/SectionPanel';
import { DeveloperFlagsPanel, type DeveloperFlagRow } from '@/components/settings/DeveloperFlagsPanel';
import { OnboardingPreview } from '@/components/dashboard/onboarding-preview/OnboardingPreview';

export const metadata: Metadata = { title: 'Developer — Settings' };

/**
 * Settings → Developer. Not linked from `SETTINGS_SECTIONS` — see
 * `SettingsNav.tsx`'s two-gate visibility check — because forcing a flag
 * variant is a debugging aid for the team building LoreKit, not a
 * customer-facing setting.
 *
 * **This `notFound()` check is the real access-control boundary** — the nav
 * link being hidden is only a visibility nicety, and a direct URL visit must
 * not bypass it. Outside production: reachable by any signed-in user (an
 * override only ever changes what YOUR OWN session sees — an accepted,
 * self-limited blast radius; see `docs/feature-flags.md` § "Session
 * overrides" for the reasoning against a role gate there). In production:
 * reachable ONLY for an email in `DEVELOPER_EMAILS`
 * (`lib/developer-users.ts`) — a customer must never reach this page at all,
 * allowlisted or not, regardless of whether they know the URL or the
 * avatar-click reveal gesture (which only ever affects the NAV LINK's
 * visibility, never this check).
 */
export default async function DeveloperSettingsPage() {
  // Server Component — the raw `VERCEL_ENV`, not the `NEXT_PUBLIC_` mirror
  // client code uses (`SettingsNav.tsx`). See `otel-deployment-env.ts`.
  const isNonProduction =
    resolveDeploymentEnvironment(process.env.VERCEL_ENV, process.env.NODE_ENV).name !== 'production';

  // Resolved unconditionally (not just inside the production gate below) so
  // `resolveFeatureFlagContext` can be passed the id and skip its own
  // `auth.getUser()` round trip — see lib/auth/verified-user.ts's header for
  // why an un-deduped extra call here would undercut that fix.
  const user = await getVerifiedUser();
  if (!isNonProduction && !isDeveloperEmail(user?.email)) notFound();

  const context = await resolveFeatureFlagContext(user?.id ?? null);

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
