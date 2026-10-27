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
 * Self-contained mirror of `packages/mcp-core/src/auth/account-wide-tools.ts` (the
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


/**
 * Operations that act on the owner's own rows without consulting the key's
 * tenancy, and so are refused outright to an `orgs_only` key (00116).
 *
 * `orgs_only` promises the owner's PERSONAL rows are out of reach. These
 * operations choose their rows by `user_id` inside the RPC (or report on the
 * owner's whole account), so there is no tenant predicate to narrow — the only
 * honest answer is to refuse the CALL, exactly as `ACCOUNT_WIDE_TOOLS` is
 * refused to a scoped key. Every other tool narrows instead: reads through
 * `applyTenantScope` / `lorekit_api_token_org_allowed`, writes through
 * `memory_write`'s personal-row refusal and `applyKeyScopeFilter`.
 */
export const OWNER_ROW_TOOLS: ReadonlySet<string> = new Set([
  ...ACCOUNT_WIDE_TOOLS,
  'memory.quota',
  'memory.protect',
  // Owner analytics: their RPCs take no tenancy and roll up the owner's own
  // reads and calls, personal keys included (00080, 00079, 00083, 00085, 00106).
  'memory.read-activity',
  'memory.read-ranking',
  'memory.utility',
  'memory.usage',
  'memory.usage-runs',
  'policy.list',
  'policy.create',
  'policy.update',
  'policy.delete',
  'groom.preview',
  'groom.run',
]);

/**
 * Is this tool refused outright for a key with this tenancy?
 *
 * Only `orgs_only` is affected; every other tenancy (and no key at all) keeps
 * exactly the behaviour it had.
 */
export function isRefusedForOrgsOnlyKey(toolName: string, orgAccess: string | undefined): boolean {
  return orgAccess === 'orgs_only' && (OWNER_ROW_TOOLS.has(toolName) || isAccountOrgTool(toolName));
}

/**
 * Org and membership management (`org.*`, `member.*`, MCP and REST). None of
 * it reads the key's `org_ids`: `org.list` and `GET /orgs` return every org the
 * owner belongs to, and the member/invite lists expose handles and invitee
 * emails. An `orgs_only` key is the one meant to be handed out, so it gets none
 * of the owner's account-level org surface.
 */
function isAccountOrgTool(toolName: string): boolean {
  return toolName.startsWith('org.') || toolName.startsWith('member.');
}

/** The refusal sentence for `isRefusedForOrgsOnlyKey`, shared by both surfaces. */
export function orgsOnlyRefusalMessage(toolName: string): string {
  const what = isAccountOrgTool(toolName) ? 'manages your account\'s organisations' : 'acts on your own memories';
  return `"${toolName}" ${what}, so it is not available to a token ` +
    'limited to selected orgs (orgs_only). Use a token that may reach your personal memories.';
}
