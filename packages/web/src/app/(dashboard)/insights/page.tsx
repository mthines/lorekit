import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getServerFlag } from '@/lib/feature-flags/server';
import { InsightsPage, InsightsPageSkeleton } from '@/components/insights/InsightsPage';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { GithubAppTeaser } from '@/components/dashboard/GithubAppTeaser';
import { PendingInvitesBanner } from '@/components/dashboard/PendingInvitesBanner';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';
import { getOnboardingState } from '@/lib/onboarding-server';
import { listPendingInvitesForMe } from '@/lib/org-invites';

export const metadata: Metadata = { title: 'Insights' };

/**
 * Gated behind the `insights-page` flag (default `off`) while the page rolls
 * out. **This `notFound()` check is the real access-control boundary** — the
 * sidebar nav item and command-palette entry being hidden
 * (`Sidebar.tsx`/`NavigationCommands.tsx`, both reading the same flag) are
 * only a visibility nicety, and a direct `/insights` visit must not bypass
 * it. Same posture as `/settings/developer`'s `notFound()` gate — see
 * `docs/feature-flags.md` § "Access in production".
 *
 * ## This page hosts onboarding, because it took Overview's home slot
 *
 * Turning the flag on removes `/overview` from the nav and points the root
 * redirect here — which stranded three surfaces that only ever rendered on
 * Overview: the pending-org-invite banner, the first-run checklist, and the
 * GitHub App teaser. Worse, `buildOnboardingSteps({ autoGenerateToken: true })`
 * is what MINTS a brand-new user's first API token, so a flag-on signup landed
 * on an analytics page with no token, no setup instructions, and no way to
 * discover either — every panel below reading zero for a reason the page could
 * not explain.
 *
 * So they move with the home slot rather than staying behind a URL nobody is
 * linked to. All three self-hide once irrelevant (dismissed / all steps done /
 * webhook already delivering), so on an established account this page renders
 * exactly as it did before.
 */
export default async function Page() {
  const enabled = await getServerFlag('insights-page');
  if (!enabled) notFound();

  const [steps, pendingInvites, onboardingState] = await Promise.all([
    buildOnboardingSteps({ autoGenerateToken: true }),
    listPendingInvitesForMe(),
    getOnboardingState(),
  ]);

  // Suspense is required, not decorative: InsightsPage's RunsList/queries read
  // client-side state that opts the subtree out of static rendering — the
  // same reason the Overview wraps DashboardStats. The fallback mirrors the
  // real layout so there is no visible reflow once data arrives.
  //
  // The onboarding surfaces sit ABOVE the analytics rather than below: on the
  // account that still needs them, every section underneath is empty, and
  // "here is how to get data" has to come before "here is your data".
  return (
    <div className="flex max-w-page flex-col gap-6">
      {pendingInvites.length > 0 && <PendingInvitesBanner initialInvites={pendingInvites} />}
      <OnboardingChecklist steps={steps} variant="inline" />
      <GithubAppTeaser hasWebhook={onboardingState.hasWebhook} />
      <Suspense fallback={<InsightsPageSkeleton />}>
        <InsightsPage />
      </Suspense>
    </div>
  );
}
