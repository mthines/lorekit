import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InsightsPageSkeleton } from '@/components/insights/InsightsPage';
import { InsightsView } from '@/components/insights/InsightsView';

export const metadata: Metadata = { title: 'Insights' };

/**
 * Analytics-only — "how are your agents actually using your lore". Onboarding
 * (the pending-invite banner, first-run checklist, and GitHub App teaser) and
 * the first-token mint live on `/lore` instead, which holds the app's home
 * slot; this page never hosted them for their own sake, only because it used
 * to be where the home slot pointed.
 *
 * Suspense is required, not decorative: InsightsPage's RunsList/queries read
 * client-side state that opts the subtree out of static rendering.
 *
 * `InsightsView` is the `insights-visual` flag resolver: off renders the
 * original `InsightsPage`, on renders the visual page. One skeleton serves both
 * arms — they share the same outer layout.
 */
export default function Page() {
  return (
    <div className="flex max-w-page flex-col gap-6">
      <Suspense fallback={<InsightsPageSkeleton />}>
        <InsightsView />
      </Suspense>
    </div>
  );
}
