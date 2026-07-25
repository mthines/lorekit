/**
 * Presentational metadata for scopes — the single source of truth for the
 * icon and friendly label used wherever a scope is rendered.
 *
 * Colours live in the shared `Badge` variants (see components/ui/Badge.tsx),
 * keyed by the same `ScopePrefix`. Keep this file free of layout so it can be
 * imported by both the `ScopeBadge` pill and the `ScopeTree` / `ScopeHealthCard`
 * custom layouts without dragging JSX along.
 */

import { Globe, Layers, FolderGit2, GitBranch, type LucideIcon } from 'lucide-react';
import { scopeType, type ScopePrefix } from '@/lib/scope';

/**
 * Icon per scope type. Previously duplicated across three components.
 * Internal — consumers use {@link scopeIcon}, so this stays unexported to keep
 * the module's public surface to the two helpers.
 */
const SCOPE_ICONS: Record<ScopePrefix, LucideIcon> = {
  global: Globe,
  project: Layers,
  repo: FolderGit2,
  branch: GitBranch,
};

/** The icon for a scope type, falling back to the global icon defensively. */
export function scopeIcon(type: ScopePrefix): LucideIcon {
  return SCOPE_ICONS[type] ?? Globe;
}

/**
 * Friendly, human-facing label for a scope — its last `::` segment.
 * `project::lorekit` → `lorekit`, `global` → `global`.
 */
export function scopeLabel(scope: string): string {
  return scope.split('::').pop() ?? scope;
}

export { scopeType };
export type { ScopePrefix };
