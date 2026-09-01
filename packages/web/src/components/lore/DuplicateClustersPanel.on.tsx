'use client';

/**
 * The `on` arm of `lore-explorer-duplicate-clusters` — the trigger is present.
 *
 * A whole standalone component, per the copy-and-suffix convention, and
 * deliberately a thin one: the trigger's own behaviour lives in
 * `DuplicateClusters.tsx`, which is where its stories and interaction tests
 * point. Splitting the ARM from the IMPLEMENTATION keeps the flag's blast
 * radius to these three small files — retiring the flag never touches the
 * component under test.
 */

import { DuplicateClusters } from './DuplicateClusters';
import type { DuplicateClustersPanelProps } from './DuplicateClustersPanel';

export function DuplicateClustersPanelOn({
  scope,
  scopeLabel,
  open,
  onToggleOpen,
}: DuplicateClustersPanelProps) {
  return (
    <DuplicateClusters scope={scope} scopeLabel={scopeLabel} open={open} onToggleOpen={onToggleOpen} />
  );
}
