import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InsightsPage, InsightsPageSkeleton } from '@/components/insights/InsightsPage';

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
 */
export default function Page() {
  return (
    <div className="flex max-w-page flex-col gap-6">
      <Suspense fallback={<InsightsPageSkeleton />}>
        <InsightsPage />
      </Suspense>
    </div>
  );
}
