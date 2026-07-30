/**
 * MCP-facing view of the audit writer.
 *
 * The implementation moved to `../_shared/audit.ts` — one canonical Deno copy
 * shared by the MCP tools and the REST handlers, instead of the previous
 * duplicate that had already drifted from `packages/mcp-core/src/audit.ts`.
 * This module stays only so `mcp/tools.ts` (and anything else importing
 * `./audit.ts`) keeps working unchanged. `mcp/` already cross-imports
 * `_shared/otel.ts`, so reaching into `_shared/` here crosses no boundary the
 * function did not already cross.
 *
 * NOTE ON THE MCP ACTOR (unchanged behaviour, documented here because it is the
 * one place the two surfaces genuinely differ): `userId` on this path is
 * auth-type-sensitive — the resolved actor for api_key calls, `null` for
 * service-role AND for user-JWT calls, because `mcp/auth.ts`'s `getUserId`
 * only returns non-null for api_key. A JWT-authenticated MCP call therefore
 * audits with `user_id = null`, which the `audit_log` INSERT policy
 * (`user_id = auth.uid()`) rejects under the JWT-scoped RLS client; the failure
 * is swallowed by `recordAudit`. That is a documented MCP limitation, not a
 * bug, and it is exactly what `recordRestAudit` fixes for the REST surface —
 * see the actor-resolution note in `_shared/audit.ts`.
 */
export { buildAuditEntry, recordAudit } from '../_shared/audit.ts';
export type { AuditAction, AuditEntryInput, AuditRow } from '../_shared/audit.ts';
