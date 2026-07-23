/**
 * Lightweight scope utilities for the web package.
 * Duplicated from packages/mcp-core/src/scope.ts to avoid pulling
 * OTel, Supabase, and tool-handler code into the Next.js webpack bundle.
 * Keep in sync with the canonical implementation in mcp-core.
 */

export type ScopePrefix = 'global' | 'project' | 'repo' | 'branch';

/**
 * Return the scope type for use as a low-cardinality attribute/badge label.
 */
export function scopeType(scope: string): ScopePrefix {
  if (scope === 'global') return 'global';
  const prefix = scope.split('::')[0] as ScopePrefix;
  return prefix;
}
