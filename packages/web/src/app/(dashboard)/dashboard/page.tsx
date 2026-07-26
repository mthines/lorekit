import type { Metadata } from 'next';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';
import { DashboardStats } from '@/components/dashboard/DashboardStats';

export const metadata: Metadata = { title: 'Overview' };

export default async function DashboardPage() {
  const steps = await buildOnboardingSteps();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Overview</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Your agents&apos; accumulated knowledge at a glance.
        </p>
      </div>

      {/* First-run setup. Dismissing hides it here; the persistent
          "Getting started" sidebar entry (and /onboarding) is the way back. */}
      <OnboardingChecklist steps={steps} variant="inline" />

      {/* Scope health stats — fetched client-side with TanStack Query so
          navigation back to this page is instant after the first load. */}
      <DashboardStats />
    </div>
  );
}
