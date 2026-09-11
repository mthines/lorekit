import { Suspense } from 'react';

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
 *
 * The onboarding reads are BEHIND A SUSPENSE BOUNDARY, and that is load-bearing
 * rather than tidiness. Awaiting them in the page body put a three-deep chain of
 * Supabase round trips (`getVerifiedUser` → `api_tokens` → scopes + orgs) on the
 * critical path of the app's landing route before a single byte of the Explorer
 * could be sent, and `/insights` — whose server-wrapper/client-extraction split
 * this page was modelled on — already streams its own slow half this way. Chrome
 * that self-hides on an established account must never be what an established
 * account waits for.
 *
 * `fallback={null}`, deliberately, not a skeleton: on the overwhelming majority
 * of renders the boundary resolves to nothing visible (no pending invite, the
 * checklist self-hidden, the teaser dismissed or the webhook already
 * delivering), so a placeholder would reserve space and then collapse — a
 * flash of onboarding chrome shown to exactly the users who have finished
 * onboarding. Nothing below the boundary moves when it resolves, because the
 * Explorer keeps its own slot in the flex column either way.
 */
export default function LorePage() {
  return (
    <div className="flex max-w-page flex-col gap-6">
      <Suspense fallback={null}>
        <LoreOnboarding />
      </Suspense>

      <LorePageClient />
    </div>
  );
}

/**
 * The onboarding chrome and the three reads that feed it, split out so the
 * `await` lands inside the Suspense boundary above instead of on the page.
 * Rendered as a fragment, not a wrapper element: the parent is the flex column
 * that owns the `gap-6` between these cards and the Explorer, and an
 * intermediate `div` would collapse the three of them into one flex item.
 */
async function LoreOnboarding() {
  const [steps, pendingInvites, onboardingState] = await Promise.all([
    buildOnboardingSteps({ autoGenerateToken: true }),
    listPendingInvitesForMe(),
    getOnboardingState(),
  ]);

  return (
    <>
      {pendingInvites.length > 0 && <PendingInvitesBanner initialInvites={pendingInvites} />}

      {/* First-run setup. Dismissing hides it here; the persistent
          "Learn" sidebar entry (and /learn/setup) is the way back. */}
      <OnboardingChecklist steps={steps} variant="inline" />

      {/* Progressive disclosure: show the webhook upsell only after the agent
          is connected. Rendered as a separate card so it never blocks allDone. */}
      <GithubAppTeaser hasWebhook={onboardingState.hasWebhook} />
    </>
  );
}
