/**
 * Token permission tiers + tool gating for the production Deno MCP edge
 * function: which MCP tools require read vs. write permission, and how a
 * token's `lk_{rw|ro|wo}_` prefix is derived from its stored `permissions`
 * array.
 *
 * Self-contained mirror of packages/mcp-core/src/auth/permissions.ts — the edge
 * function has no cross-package imports (Deno / Node.js MCP SDK
 * incompatibility), so this module deliberately duplicates the logic rather
 * than importing it. Keep the two in sync when either changes.
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
  // `org.list` is a read like any other. It used to be ungated because the org
  // tools were JWT-only; they now serve `lk_*` tokens, and listing the orgs you
  // belong to is exactly the shape of thing a read token should be able to do.
  'org.list',
  // Retention policies ("grooming") — listing saved rules and previewing what
  // a rule would archive are both reads, same family as memory.list_archived.
  'policy.list',
  'groom.preview',
]);

/** Write-family tools — require `canWrite`. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'memory.write',
  'memory.delete',
  'memory.archive',
  'memory.restore',
  'memory.purge',
  'memory.purge_expired',
  // Org MUTATIONS need write permission. This is orthogonal to the caller's org
  // ROLE and does not replace it: a `lk_rw_*` token held by a viewer still
  // cannot rename or delete, because `lorekit_org_can` inside the SECURITY
  // DEFINER RPCs remains the only role→capability source. Token permission says
  // what the KEY may attempt; the role says what the PERSON may do.
  'org.create',
  'org.rename',
  'org.delete',
  // Retention policies ("grooming") — saving/changing a rule, running a sweep,
  // and toggling protection all mutate state.
  'policy.create',
  'policy.update',
  'policy.delete',
  'groom.run',
  'memory.protect',
]);

/**
 * Which permission a tool name requires, or null if the tool is unknown to
 * the gating switch.
 */
export function toolRequires(toolName: string): Permission | null {
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  return null;
}

/**
 * Derive the token prefix suffix (`rw` | `ro` | `wo`) from a permission set.
 * Total function; throws on an empty/invalid set.
 */
export function tokenPrefixFor(permissions: readonly Permission[]): 'rw' | 'ro' | 'wo' {
  const hasRead = permissions.includes('read');
  const hasWrite = permissions.includes('write');
  if (hasRead && hasWrite) return 'rw';
  if (hasWrite) return 'wo';
  if (hasRead) return 'ro';
  throw new Error('tokenPrefixFor: permissions must include at least "read" or "write"');
}

// `ACCOUNT_WIDE_TOOLS` / `isRefusedForScopedKey` deliberately do NOT live here,
// even though tool-name gating otherwise does. They live in
// `../_shared/auth/account-wide-tools.ts` because BOTH transports enforce the
// decision: the MCP dispatcher and the REST purge endpoints. The REST tree
// cannot cross-import this directory, so a rule kept in this file could only
// ever be copied to reach it — and a copied rule is what would let
// `POST /memories/purge` ship with no key gate while the docs said it was
// refused.
