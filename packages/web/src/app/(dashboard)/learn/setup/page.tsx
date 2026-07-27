import type { Metadata } from 'next';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { WebhookTeaser } from '@/components/dashboard/WebhookTeaser';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';
import { getOnboardingState } from '@/lib/onboarding-server';

export const metadata: Metadata = { title: 'Getting started — Learn' };

export default async function LearnSetupPage() {
  const [steps, onboardingState] = await Promise.all([
    buildOnboardingSteps(),
    getOnboardingState(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-[var(--color-content-primary)]">Getting started</h2>
        <p className="mt-1 text-sm text-[var(--color-content-secondary)]">
          Everything you need to connect LoreKit to your agents — in one place.
        </p>
      </div>

      <OnboardingChecklist steps={steps} variant="page" />

      {/* Webhook is optional enrichment, not a required step. Surface it below
          the checklist as a secondary discovery card. */}
      <WebhookTeaser hasWebhook={onboardingState.hasWebhook} />
    </div>
  );
}
