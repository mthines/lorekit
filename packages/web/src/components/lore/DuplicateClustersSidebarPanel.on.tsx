'use client';

/**
 * The `on` arm of `lore-explorer-duplicate-clusters` for the sidebar body.
 *
 * Thin, like `DuplicateClustersPanel.on.tsx`: the sidebar's own behaviour
 * lives in `DuplicateClustersSidebar.tsx`. Also gates on `open` itself, so a
 * closed sidebar contributes nothing to the DOM (and runs no query) even
 * though the flag is on — matching `DuplicateClusters`'s own "folded means not
 * fetched" rule for the trigger.
 */

import { DuplicateClustersSidebar } from './DuplicateClustersSidebar';
import type { DuplicateClustersSidebarPanelProps } from './DuplicateClustersSidebarPanel';

export function DuplicateClustersSidebarPanelOn({
  open,
  scope,
  scopeLabel,
  selectedClusterId,
  onSelectCluster,
  onClose,
}: DuplicateClustersSidebarPanelProps) {
  if (!open) return null;
  return (
    <DuplicateClustersSidebar
      scope={scope}
      scopeLabel={scopeLabel}
      selectedClusterId={selectedClusterId}
      onSelectCluster={onSelectCluster}
      onClose={onClose}
    />
  );
}
