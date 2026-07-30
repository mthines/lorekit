/**
 * Append-only audit trail for security/data-affecting actions across LoreKit:
 * API-key lifecycle, webhook-secret changes, memory mutations, and limit
 * overrides (supabase/migrations/00010_audit_log.sql).
 *
 * Two layers, mirroring the limits.ts / created-at.ts convention:
 *   - buildAuditEntry(input)          — pure: shapes the audit_log row.
 *   - recordAudit(db, input, userId)  — impure shell: inserts the row and
 *     NEVER throws — a failed audit write must never break the primary
 *     operation it is auditing (a memory write, a token revoke, etc). Errors
 *     are logged, not surfaced.
 *
 * The Deno counterpart is supabase/functions/_shared/audit.ts (re-exported by
 * supabase/functions/mcp/audit.ts) — the edge runtime cannot cross-import this
 * package, so buildAuditEntry/recordAudit stay duplicated there (the limits.ts
 * pattern). Keep buildAuditEntry's body byte-consistent between the two copies.
 * The action vocabulary and the three types are NOT duplicated: both writers
 * import them from @lorekit/schemas, the single source of truth.
 *
 * CAPTURE MODEL (Decision D1): every action here is recorded by an explicit
 * app-layer call right after its primary operation succeeds — NOT by a DB
 * trigger on the data tables. The one deliberate exception (Decision D2) is
 * `limit.override`: no app-layer path writes `user_limits` today, so a DB
 * trigger (`audit_user_limits()`, in the 00010 migration) is the only way to
 * capture it. See CLAUDE.md "Key decisions" for the full rationale.
 *
 * `userId` is auth-type-sensitive: the resolved actor for user/api_key
 * writes, `null` for service-role/CI writes (exempt from RLS SELECT,
 * mirroring the memory-cap exemption in limits.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { AUDIT_ACTIONS } from '@lorekit/schemas/audit';
import type { AuditAction, AuditEntryInput, AuditRow } from '@lorekit/schemas/audit';

export { AUDIT_ACTIONS };
export type { AuditAction, AuditEntryInput, AuditRow };

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
  db: SupabaseClient,
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
