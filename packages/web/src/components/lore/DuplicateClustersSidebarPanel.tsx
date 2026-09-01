'use client';

/**
 * The flag resolver for the Explorer's Duplicate Clusters SIDEBAR body —
 * `DuplicateClustersPanel`'s sibling resolver for the same
 * `lore-explorer-duplicate-clusters` flag.
 *
 * Split from `DuplicateClustersPanel` because the two render in different
 * parts of `LoreExplorer`'s layout: the trigger sits above the results card,
 * the sidebar sits beside it as a flex column (see `LoreExplorer.tsx`'s
 * results wrapper). Keeping one resolver per render site is what lets
 * `LoreExplorer.tsx` place each with no flag conditional of its own — same
 * "resolver decides, page just renders it" shape as every other flag in this
 * package.
 *
 * `off` renders nothing, same as `DuplicateClustersPanelOff` — see that file's
 * docblock for why an absent arm is a whole component rather than an inlined
 * `null`. `on` additionally checks `open` itself (rather than the caller
 * gating with `{open && <.../>}`), so `LoreExplorer.tsx` stays free of that
 * conditional too.
 */

import { useFeatureFlagVariant } from '@/components/providers/FeatureFlagsProvider';
import { DuplicateClustersSidebarPanelOff } from './DuplicateClustersSidebarPanel.off';
import { DuplicateClustersSidebarPanelOn } from './DuplicateClustersSidebarPanel.on';
import type { DuplicateCluster } from '@lorekit/schemas/memory';

export interface DuplicateClustersSidebarPanelProps {
  /** Whether the sidebar should render — controlled by the caller (`LoreExplorer`). */
  open: boolean;
  /** The Explorer's selected scope, or `null` for every scope the viewer can see. */
  scope: string | null;
  /** Human label for the current scope, for the sidebar's captions. */
  scopeLabel: string;
  /** The natural id of the cluster currently driving the list, or null. */
  selectedClusterId: string | null;
  /** Picks (or clears) the cluster the list shows. */
  onSelectCluster: (cluster: DuplicateCluster | null) => void;
  onClose: () => void;
}

export function DuplicateClustersSidebarPanel(props: DuplicateClustersSidebarPanelProps) {
  const variant = useFeatureFlagVariant('lore-explorer-duplicate-clusters');
  switch (variant) {
    case 'on':
      return <DuplicateClustersSidebarPanelOn {...props} />;
    case 'off':
    default:
      return <DuplicateClustersSidebarPanelOff />;
  }
}
