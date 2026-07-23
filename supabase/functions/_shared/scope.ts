/**
 * Canonical scope validation — shared across Edge Functions.
 * Mirrors packages/mcp-core/src/scope.ts for the Deno runtime.
 */

export type ScopePrefix = 'global' | 'project' | 'repo' | 'branch';
const VALID_PREFIXES: ScopePrefix[] = ['global', 'project', 'repo', 'branch'];

export function validateScope(raw: string): string {
  if (!raw) throw new Error('scope must be a non-empty string');
  if (/^(project|repo|branch):[^:]/.test(raw)) {
    throw new Error(`Invalid scope "${raw}": use "::" as the separator, not ":"`);
  }
  const normalized = raw.toLowerCase().trim();
  if (normalized === 'global') return 'global';
  const sepIdx = normalized.indexOf('::');
  if (sepIdx === -1) throw new Error(`Invalid scope "${raw}": unknown scope type`);
  const prefix = normalized.slice(0, sepIdx) as ScopePrefix;
  if (!VALID_PREFIXES.includes(prefix)) throw new Error(`Invalid scope prefix "${prefix}"`);
  return normalized;
}
