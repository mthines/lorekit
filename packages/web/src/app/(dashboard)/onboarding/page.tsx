import type { Metadata } from 'next';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';

export const metadata: Metadata = { title: 'Getting started' };

export default async function OnboardingPage() {
  const steps = await buildOnboardingSteps();

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-content-primary)]">Getting started</h1>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Everything you need to connect LoreKit to your agents and repos — in one place.
        </p>
      </div>

      <OnboardingChecklist steps={steps} variant="page" />
    </div>
  );
}
