'use client';

/**
 * The flag resolver for the Explorer's Duplicate Clusters panel.
 *
 * `lore-explorer-duplicate-clusters` decides whether the panel exists at all, and
 * this is the ONLY file the Explorer imports — so `LoreExplorer.tsx` carries no
 * flag read, no `&&`, and nothing to untangle when the rollout finishes.
 *
 * ## Why a resolver rather than `{enabled && <Panel/>}`
 *
 * The copy-and-suffix convention (`packages/feature-flags/CLAUDE.md` § "A
 * UI-affecting experiment's arms are separate components"): each arm is a whole
 * standalone component in its own file, and the resolver dispatches on the
 * variant KEY — never on the resolved VALUE, which tells you `true`/`false` but
 * not which arm to render and does not generalise past two variants. Retiring
 * the flag is then four deletions rather than a diff into shared logic: promote
 * `.on`'s body here, delete `.off`, delete the `switch`, drop the registry entry.
 *
 * ## `default` is OFF, deliberately
 *
 * The `default` arm catches an unknown variant — a stale override cookie, or a
 * variant renamed in the registry — and it lands on `off`. For a panel that
 * issues a quadratic-in-the-worst-case server read, "I could not tell" must mean
 * "do not render", never "render it anyway". This matches the registry's
 * `defaultVariant: 'off'` so the two cannot disagree.
 */

import { useFeatureFlagVariant } from '@/components/providers/FeatureFlagsProvider';
import { DuplicateClustersPanelOff } from './DuplicateClustersPanel.off';
import { DuplicateClustersPanelOn } from './DuplicateClustersPanel.on';

export interface DuplicateClustersPanelProps {
  /** The Explorer's selected scope, or `null` for every scope the viewer can see. */
  scope: string | null;
  /** Human label for the current scope, for the panel's captions. */
  scopeLabel: string;
  /** Opens a member in the Explorer's detail sheet. */
  onOpenLesson: (ref: { scope: string; key: string }) => void;
}

export function DuplicateClustersPanel(props: DuplicateClustersPanelProps) {
  const variant = useFeatureFlagVariant('lore-explorer-duplicate-clusters');
  switch (variant) {
    case 'on':
      return <DuplicateClustersPanelOn {...props} />;
    case 'off':
    default:
      return <DuplicateClustersPanelOff />;
  }
}
