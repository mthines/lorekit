/**
 * The operations that sweep the caller's WHOLE account, and the refusal rule a
 * scoped key meets when it reaches one.
 *
 * Lifted out of `permissions.ts` because BOTH transports need it and neither
 * can reach the other: `memory.purge` / `memory.purge_expired` are MCP tools,
 * `POST /memories/purge` / `/purge-expired` are their REST twins, and the REST
 * tree cannot cross-import `supabase/functions/mcp/`. Two copies of "which
 * operations are account-wide" is precisely the drift that let the REST purge
 * endpoints ship with no key gate while the docs said they were refused, so the
 * decision lives in one importable module — the same move `tenant-scope.ts`
 * made for the tenant predicate.
 *
 * The set is keyed on the MCP tool name, which is also the REST vocabulary:
 * `rest-tool-name.ts` maps `memories POST /purge` to `memory.purge`, so the
 * two surfaces name the same operation the same way and no second list exists.
 *
 * Self-contained mirror of `packages/mcp-core/src/account-wide-tools.ts` (the
 * edge tree cannot cross-import that package). Keep the two in sync;
 * `edge-parity.spec.ts` fails when they drift.
 */

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

/**
 * The refusal sentence both surfaces render, so the MCP `-32003` error and the
 * REST `403` body say the same thing about the same operation.
 */
export function accountWideRefusalMessage(toolName: string): string {
  return `"${toolName}" operates across your whole account, so it is not available to a ` +
    'token restricted to specific scopes. Use an unscoped token for maintenance sweeps.';
}
