import type { Metadata } from 'next';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';
import { listPendingInvitesForMe } from '@/lib/org-invites';
import { DashboardStats } from '@/components/dashboard/DashboardStats';
import { PendingInvitesBanner } from '@/components/dashboard/PendingInvitesBanner';

export const metadata: Metadata = { title: 'Overview' };

export default async function DashboardPage() {
  // Overview is the default landing route — the single place that mints a
  // first token so brand-new users get a ready-to-copy config immediately.
  // Pending org invites are fetched alongside so the banner can surface them.
  const [steps, pendingInvites] = await Promise.all([
    buildOnboardingSteps({ autoGenerateToken: true }),
    listPendingInvitesForMe(),
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
          "Getting started" sidebar entry (and /onboarding) is the way back. */}
      <OnboardingChecklist steps={steps} variant="inline" />

      {/* Scope health stats — fetched client-side with TanStack Query so
          navigation back to this page is instant after the first load. */}
      <DashboardStats />
    </div>
  );
}
