import type { Metadata } from 'next';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { GithubAppTeaser } from '@/components/dashboard/GithubAppTeaser';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';
import { getOnboardingState } from '@/lib/onboarding-server';
import { listPendingInvitesForMe } from '@/lib/org-invites';
import { Suspense } from 'react';
import { DashboardStats, DashboardStatsSkeleton } from '@/components/dashboard/DashboardStats';
import { PendingInvitesBanner } from '@/components/dashboard/PendingInvitesBanner';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  // Overview is the default landing route — the single place that mints a
  // first token so brand-new users get a ready-to-copy config immediately.
  // Pending org invites are fetched alongside so the banner can surface them.
  const [steps, pendingInvites, onboardingState] = await Promise.all([
    buildOnboardingSteps({ autoGenerateToken: true }),
    listPendingInvitesForMe(),
    getOnboardingState(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Overview</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Your agents&apos; accumulated knowledge at a glance.
        </p>
      </div>

      {pendingInvites.length > 0 && <PendingInvitesBanner initialInvites={pendingInvites} />}

      {/* First-run setup. Dismissing hides it here; the persistent
          "Learn" sidebar entry (and /learn/setup) is the way back. */}
      <OnboardingChecklist steps={steps} variant="inline" />

      {/* Progressive disclosure: show the webhook upsell only after the agent
          is connected. Rendered as a separate card so it never blocks allDone. */}
      <GithubAppTeaser hasWebhook={onboardingState.hasWebhook} />

      {/* Scope health stats — fetched client-side with TanStack Query so
          navigation back to this page is instant after the first load.

          The Suspense boundary is REQUIRED, not decorative: the stat row's time
          range moved from local state onto the shared URL-backed model, so the
          subtree now calls `useSearchParams()`. Without a boundary Next.js
          opts the whole route out of static rendering (and fails the build in
          CI). The fallback is the skeleton the component already renders while
          its own query is in flight, so the shell is unchanged. */}
      <Suspense fallback={<DashboardStatsSkeleton />}>
        <DashboardStats />
      </Suspense>
    </div>
  );
}
