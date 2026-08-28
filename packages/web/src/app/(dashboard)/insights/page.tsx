import type { Metadata } from 'next';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { getServerFlag } from '@/lib/feature-flags/server';
import { InsightsPage, InsightsPageSkeleton } from '@/components/insights/InsightsPage';

export const metadata: Metadata = { title: 'Insights' };

/**
 * Gated behind the `insights-page` flag (default `off`) while the page rolls
 * out. **This `notFound()` check is the real access-control boundary** — the
 * sidebar nav item and command-palette entry being hidden
 * (`Sidebar.tsx`/`NavigationCommands.tsx`, both reading the same flag) are
 * only a visibility nicety, and a direct `/insights` visit must not bypass
 * it. Same posture as `/settings/developer`'s `notFound()` gate — see
 * `docs/feature-flags.md` § "Access in production".
 */
export default async function Page() {
  const enabled = await getServerFlag('insights-page');
  if (!enabled) notFound();

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
