'use client';

/**
 * The flag resolver for the Insights "Connections" panel.
 *
 * `memory-graph` decides whether the panel exists, and this is the ONLY file
 * `InsightsVisualPage` imports for it. Copy-and-suffix convention
 * (`packages/feature-flags/CLAUDE.md`): each arm is a whole component in its own
 * file, the resolver switches on the variant KEY, and `default` is OFF — the
 * `.on` arm issues a self-join over the citation ledger, so "I could not tell"
 * must mean "do not render".
 */

import { useFeatureFlagVariant } from '@/components/providers/FeatureFlagsProvider';
import { ConnectionsGraphOff } from './ConnectionsGraph.off';
import { ConnectionsGraphOn, type ConnectionsGraphProps } from './ConnectionsGraph.on';

export type { ConnectionsGraphProps };

export function ConnectionsGraph(props: ConnectionsGraphProps) {
  const variant = useFeatureFlagVariant('memory-graph');
  switch (variant) {
    case 'on':
      return <ConnectionsGraphOn {...props} />;
    case 'off':
    default:
      return <ConnectionsGraphOff />;
  }
}
