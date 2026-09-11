import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { GithubAppTeaser } from '@/components/dashboard/GithubAppTeaser';
import { PendingInvitesBanner } from '@/components/dashboard/PendingInvitesBanner';
import { buildOnboardingSteps } from '@/lib/onboarding-steps';
import { getOnboardingState } from '@/lib/onboarding-server';
import { listPendingInvitesForMe } from '@/lib/org-invites';
import LorePageClient from './LorePageClient';

/**
 * `/lore` is the app's default landing route — the single place that mints a
 * first token so brand-new users get a ready-to-copy config immediately.
 * Onboarding lives here, above the Explorer, mirroring the pattern that used
 * to live on the now-deleted `/overview` page: pending org invites, the
 * first-run checklist, and the GitHub App teaser all self-hide once
 * irrelevant (dismissed / all steps done / webhook already delivering), so on
 * an established account this page renders exactly as it did before —
 * onboarding chrome above, the Explorer below.
 */
export default async function LorePage() {
  const [steps, pendingInvites, onboardingState] = await Promise.all([
    buildOnboardingSteps({ autoGenerateToken: true }),
    listPendingInvitesForMe(),
    getOnboardingState(),
  ]);

  return (
    <div className="flex max-w-page flex-col gap-6">
      {pendingInvites.length > 0 && <PendingInvitesBanner initialInvites={pendingInvites} />}

      {/* First-run setup. Dismissing hides it here; the persistent
          "Learn" sidebar entry (and /learn/setup) is the way back. */}
      <OnboardingChecklist steps={steps} variant="inline" />

      {/* Progressive disclosure: show the webhook upsell only after the agent
          is connected. Rendered as a separate card so it never blocks allDone. */}
      <GithubAppTeaser hasWebhook={onboardingState.hasWebhook} />

      <LorePageClient />
    </div>
  );
}
