'use client';

/**
 * The `on` arm of `insights-visual` — the visual page.
 *
 * Deliberately thin: the behaviour, stories and pixel baselines live in
 * `visual/InsightsVisualPage.tsx`, so retiring the flag never touches the
 * component under test.
 */

import { InsightsVisualPage } from './visual/InsightsVisualPage';

export function InsightsViewOn() {
  return <InsightsVisualPage />;
}
