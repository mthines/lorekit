/**
 * Canonical scope validation — shared across Edge Functions.
 * Mirrors packages/mcp-core/src/scope.ts for the Deno runtime.
 */

export type ScopePrefix = 'global' | 'project' | 'repo' | 'branch';
const VALID_PREFIXES = new Set<string>(['global', 'project', 'repo', 'branch']);

/**
 * Sentinel for caller-supplied input that is structurally invalid (bad scope
 * format, unknown prefix, etc.). Handlers that catch this should NOT mark the
 * span as ERROR — the service behaved correctly; the caller sent bad input.
 * Mirrors the OTel semantic-convention rule that server spans are ERROR only
 * for server-side faults, not 4xx client errors.
 */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserInputError';
  }
}

export function validateScope(raw: string): string {
  if (!raw) throw new UserInputError('scope must be a non-empty string');
  if (/^(project|repo|branch):[^:]/.test(raw)) {
    throw new UserInputError(`Invalid scope "${raw}": use "::" as the separator, not ":"`);
  }
  const normalized = raw.toLowerCase().trim();
  if (normalized === 'global') return 'global';
  const sepIdx = normalized.indexOf('::');
  if (sepIdx === -1) throw new UserInputError(`Invalid scope "${raw}": unknown scope type`);
  const prefix = normalized.slice(0, sepIdx) as ScopePrefix;
  if (!VALID_PREFIXES.has(prefix)) throw new UserInputError(`Invalid scope prefix "${prefix}"`);
  // SECURITY: a validated scope is interpolated into a PostgREST `.or()` filter
  // by the search handler (`scope.in.("<scope>")`), where `"` `,` `(` `)` are
  // structural. A canonical scope only ever uses word chars plus `. : / -`, so
  // reject anything else — otherwise `project::a",value.not.is.null` would break
  // out of the quoted filter value. (This mirror is intentionally lighter than
  // packages/mcp-core/src/scope.ts, so this guard must live here in its own right.)
  if (!/^[\w.:/-]+$/.test(normalized)) {
    throw new UserInputError(`Invalid scope "${raw}": contains unsupported characters`);
  }
  return normalized;
}


