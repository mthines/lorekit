import type { Metadata } from 'next';
import { Suspense } from 'react';
import { InsightsPage, InsightsPageSkeleton } from '@/components/insights/InsightsPage';

export const metadata: Metadata = { title: 'Insights' };

export default function Page() {
  // Suspense is required, not decorative: InsightsPage's RunsList/queries read
  // client-side state that opts the subtree out of static rendering — the
  // same reason the Overview wraps DashboardStats. The fallback mirrors the
  // real layout so there is no visible reflow once data arrives.
  return (
    <Suspense fallback={<InsightsPageSkeleton />}>
      <InsightsPage />
    </Suspense>
  );
}
