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

// `ACCOUNT_WIDE_TOOLS` / `isRefusedForScopedKey` used to live here. They moved
// to `account-wide-tools.ts` when the REST purge endpoints needed the same
// decision: the REST tree cannot cross-import `supabase/functions/mcp/`, so a
// rule kept in this file could only ever be copied, and the copy is what let
// `POST /memories/purge` ship with no key gate while the docs said it was
// refused.
