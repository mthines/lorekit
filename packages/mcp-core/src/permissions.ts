/**
 * Token permission tiers + tool gating — the single source of truth for
 * which MCP tools require read vs. write permission, and for deriving a
 * token's `lk_{rw|ro|wo}_` prefix from its stored `permissions` array.
 *
 * Mirrored (self-contained, no cross-package import) in
 * supabase/functions/mcp/permissions.ts for the Deno edge function — the
 * `limits.ts` / `created-at.ts` pattern. Keep the two in sync when either
 * changes.
 */

export type Permission = 'read' | 'write';

/** Read-family tools — require `canRead`. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'memory.read',
  'memory.list',
  'memory.search',
  'memory.list_archived',
]);

/** Write-family tools — require `canWrite`. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'memory.write',
  'memory.delete',
  'memory.archive',
  'memory.restore',
  'memory.purge',
  'memory.purge_expired',
]);

/**
 * Which permission a tool name requires, or null if the tool is unknown to
 * the gating switch (e.g. not a `memory.*` tool — the caller's own
 * "unknown tool" handling applies).
 */
export function toolRequires(toolName: string): Permission | null {
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  return null;
}

/**
 * Derive the token prefix suffix (`rw` | `ro` | `wo`) from a permission set.
 * Total function over the three valid non-empty subsets of `{read, write}`;
 * throws on an empty/invalid set so callers never persist an unclassifiable
 * token.
 */
export function tokenPrefixFor(permissions: readonly Permission[]): 'rw' | 'ro' | 'wo' {
  const hasRead = permissions.includes('read');
  const hasWrite = permissions.includes('write');
  if (hasRead && hasWrite) return 'rw';
  if (hasWrite) return 'wo';
  if (hasRead) return 'ro';
  throw new Error('tokenPrefixFor: permissions must include at least "read" or "write"');
}
