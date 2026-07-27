import type { Metadata } from 'next';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';

export const metadata: Metadata = { title: 'Getting started — Learn' };

export default async function LearnSetupPage() {
  const steps = await buildOnboardingSteps();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Getting started</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Everything you need to connect LoreKit to your agents and repos — in one place.
        </p>
      </div>

      <OnboardingChecklist steps={steps} variant="page" />
    </div>
  );
}
