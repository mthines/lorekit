'use client';

/**
 * The flag resolver for the lesson drawer's "Connections" section.
 *
 * `memory-graph` decides whether the section exists at all, and this is the ONLY
 * file `LessonDetailSheet` imports for it — so the sheet carries no flag read
 * and nothing to untangle when the rollout ends. Copy-and-suffix convention
 * (`packages/feature-flags/CLAUDE.md`): each arm is a whole component in its own
 * file and the resolver dispatches on the variant KEY.
 *
 * `default` is OFF: an unknown variant (a stale override, a renamed variant)
 * must mean "do not render" — the `.on` arm issues a server read once opened.
 */

import { useFeatureFlagVariant } from '@/components/providers/FeatureFlagsProvider';
import { MemoryConnectionsOff } from './MemoryConnections.off';
import { MemoryConnectionsOn, type MemoryConnectionsProps } from './MemoryConnections.on';

export type { MemoryConnectionsProps };

export function MemoryConnections(props: MemoryConnectionsProps) {
  const variant = useFeatureFlagVariant('memory-graph');
  switch (variant) {
    case 'on':
      return <MemoryConnectionsOn {...props} />;
    case 'off':
    default:
      return <MemoryConnectionsOff />;
  }
}
