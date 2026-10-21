'use client';

/**
 * The flag resolver for the `/insights` page body (`insights-visual`).
 *
 * The route imports only this file, so `page.tsx` carries no flag read and
 * nothing to untangle when the rollout ends — the copy-and-suffix convention
 * (`packages/feature-flags/CLAUDE.md`, live example
 * `components/lore/DuplicateClustersPanel{,.on,.off}.tsx`). Each arm is a whole
 * standalone component; this dispatches on the variant KEY, never the value.
 *
 * Retiring the flag: promote `.on`'s body here (or re-export
 * `InsightsVisualPage`), delete `.off` and — once nothing else needs it — the
 * original `InsightsPage`, delete this `switch`, drop the registry entry.
 *
 * `default` is OFF: an unknown variant (a stale override cookie, a renamed
 * variant) must land on the page every reader already knows, matching the
 * registry's `defaultVariant: 'off'` so the two cannot disagree.
 */

import { useFeatureFlagVariant } from '@/components/providers/FeatureFlagsProvider';
import { InsightsViewOff } from './InsightsView.off';
import { InsightsViewOn } from './InsightsView.on';

export function InsightsView() {
  const variant = useFeatureFlagVariant('insights-visual');
  switch (variant) {
    case 'on':
      return <InsightsViewOn />;
    case 'off':
    default:
      return <InsightsViewOff />;
  }
}
