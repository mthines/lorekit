'use client';

/**
 * The `off` arm of `insights-visual` — the original Insights page, unchanged.
 *
 * A whole component rather than an inlined `<InsightsPage />` in the resolver,
 * so retiring the flag is "delete this file" — a complete instruction.
 */

import { InsightsPage } from './InsightsPage';

export function InsightsViewOff() {
  return <InsightsPage />;
}
