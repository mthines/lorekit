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
  // The inventory read. It takes no scope — that is the point of it — so it is
  // read-gated like the rest of the family rather than left ungated because it
  // names no scope: scope STRINGS embed repo and project names, which is the
  // same reason `lorekit_memory_scopes` carries no `anon` grant.
  //
  // NOTE for the read-activity metric: `lorekit_read_activity` (00053) sums
  // `result_count` over a HARD-CODED list of the four tools above and must NOT
  // grow this one. That series answers "how many MEMORIES did I read"; this tool
  // returns scope rows, not memories, so counting it would inflate the number
  // with records that are not lore. Permission gating and the records-read
  // metric are different questions about the same family.
  'memory.scopes',
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

/**
 * Tools that operate over the caller's WHOLE account and carry no scope.
 *
 * A scoped key must not reach them: `memory.purge` and `memory.purge_expired`
 * hard-delete rows across every scope the owner has, and a key narrowed to one
 * repo has no business sweeping the account. There is no scope argument to
 * refuse and no query to narrow — the row set is chosen inside the RPC — so the
 * only available answer is to refuse the CALL.
 *
 * Named explicitly rather than derived from "takes no scope argument": that
 * would also catch `memory.scopes`, which is narrowed rather than refused
 * because it returns a catalog and an empty catalog is a truthful answer.
 */
export const ACCOUNT_WIDE_TOOLS: ReadonlySet<string> = new Set([
  'memory.purge',
  'memory.purge_expired',
]);

/**
 * Is this tool refused outright for a key carrying a scope allowlist?
 *
 * Total, and false for an unrestricted key — scoping must not change behaviour
 * for a token nobody scoped.
 */
export function isRefusedForScopedKey(toolName: string, hasScopeAllowlist: boolean): boolean {
  return hasScopeAllowlist && ACCOUNT_WIDE_TOOLS.has(toolName);
}
