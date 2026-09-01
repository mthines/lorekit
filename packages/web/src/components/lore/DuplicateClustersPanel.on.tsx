'use client';

/**
 * The `on` arm of `lore-explorer-duplicate-clusters` — the panel is present.
 *
 * A whole standalone component, per the copy-and-suffix convention, and
 * deliberately a thin one: the panel's own behaviour lives in
 * `DuplicateClusters.tsx`, which is where its stories, interaction tests and
 * pixel baselines point. Splitting the ARM from the IMPLEMENTATION keeps the
 * flag's blast radius to these three small files — retiring the flag never
 * touches the component under test.
 *
 * Note what this arm does NOT do: it does not decide whether the panel is open,
 * and it does not fetch. The panel opens collapsed and its React Query `enabled`
 * flag IS that disclosure, so with the flag on and the panel folded there is
 * still no clustering request. The flag and the disclosure are two independent
 * gates, in that order.
 */

import { DuplicateClusters } from './DuplicateClusters';
import type { DuplicateClustersPanelProps } from './DuplicateClustersPanel';

export function DuplicateClustersPanelOn({
  scope,
  scopeLabel,
  onOpenLesson,
}: DuplicateClustersPanelProps) {
  return <DuplicateClusters scope={scope} scopeLabel={scopeLabel} onOpenLesson={onOpenLesson} />;
}
