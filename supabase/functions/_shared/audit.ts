/**
 * Append-only audit trail for security/data-affecting actions across LoreKit:
 * API-key lifecycle, webhook-secret changes, memory mutations, and limit
 * overrides (supabase/migrations/00010_audit_log.sql).
 *
 * THE single audit writer for the whole edge tree. It lives in `_shared/`
 * (not `mcp/`) because both surfaces use it: the MCP tools
 * (`supabase/functions/mcp/tools.ts`) and the REST handlers
 * (`supabase/functions/memories/handlers/*.ts`). There must never be a second
 * edge audit writer — the two surfaces must produce comparable rows.
 *
 * Self-contained mirror of the shared Node audit writer (`@lorekit/core`'s
 * `src/audit.ts`) — the edge function has no cross-package imports (Deno /
 * Node.js MCP SDK incompatibility), so this module deliberately duplicates
 * the logic rather than importing it. Keep buildAuditEntry's body
 * byte-consistent with that copy; the vitest suite over it is the shared guard.
 * NOTE: the two copies are NOT whole-file comparable by
 * `packages/mcp-core/src/edge-parity.spec.ts` — they differ in their client
 * typing (`SupabaseClient` from the bare `@supabase/supabase-js` import in
 * mcp-core vs `ReturnType<typeof createClient>` off the `npm:` specifier
 * here), which is precisely the Node/Deno import split the mirror exists for.
 *
 * CAPTURE MODEL (Decision D1): every action here is recorded by an explicit
 * app-layer call right after its primary operation succeeds — NOT by a DB
 * trigger on the data tables. The one deliberate exception (Decision D2) is
 * `limit.override`: no app-layer path writes `user_limits` today, so a DB
 * trigger (`audit_user_limits()`, in the 00010 migration) is the only way to
 * capture it. See CLAUDE.md "Key decisions" for the full rationale.
 *
 * `userId` is auth-type-sensitive (see auth.ts getUserId): the resolved
 * actor for api_key calls, `null` for service-role AND for user-JWT calls
 * (getUserId only returns non-null for the api_key auth type — RLS already
 * scopes JWT reads/writes, so no distinct app userId is resolved for that
 * path). A JWT-authenticated MCP call that mutates memory therefore audits
 * with user_id = null; because the audit_log INSERT policy requires
 * `user_id = auth.uid()`, and the edge's JWT-scoped db client enforces RLS,
 * that insert fails RLS and is swallowed by recordAudit below — a documented
 * limitation (see plan.md Edge Cases), not a bug. Service-role and api_key
 * calls use the service-role client (bypasses RLS), so their audit inserts
 * always succeed regardless of user_id.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

export const AUDIT_ACTIONS = [
  'api_key.create',
  'api_key.revoke',
  'webhook_secret.create',
  'webhook_secret.rotate',
  'webhook_secret.deactivate',
  'memory.create',
  'memory.update',
  'memory.archive',
  'memory.restore',
  'memory.delete',
  'limit.override',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntryInput {
  action: AuditAction;
  resourceType?: string | null;
  resourceId?: string | null;
  target?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditRow {
  action: AuditAction;
  resource_type: string | null;
  resource_id: string | null;
  target: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Pure: shape the audit_log row from a caller's input. No I/O, no actor
 * resolution — that's recordAudit's job (the impure shell below).
 */
export function buildAuditEntry(input: AuditEntryInput): AuditRow {
  return {
    action: input.action,
    resource_type: input.resourceType ?? null,
    resource_id: input.resourceId ?? null,
    target: input.target ?? null,
    metadata: input.metadata ?? null,
  };
}

/**
 * Insert one audit_log row. NEVER throws: the primary operation being
 * audited has already committed by the time this is called, and an audit
 * failure (RLS denial, network blip, constraint violation) must not undo it
 * or surface as an error to the caller. Failures are logged via
 * console.error for observability, not rethrown.
 */
export async function recordAudit(
  db: ReturnType<typeof createClient>,
  input: AuditEntryInput,
  userId: string | null,
): Promise<void> {
  try {
    const row = buildAuditEntry(input);
    const { error } = await db.from('audit_log').insert({ ...row, user_id: userId });
    if (error) {
      console.error(`[recordAudit] insert failed for action=${input.action}:`, error.message);
    }
  } catch (err) {
    console.error(`[recordAudit] unexpected error for action=${input.action}:`, (err as Error).message);
  }
}
