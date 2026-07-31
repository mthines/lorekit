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
 * VOCABULARY: `AUDIT_ACTIONS` / `AuditAction` are NOT declared here. They come
 * from the generated schema mirror `./schemas/audit.ts` (source of truth:
 * `packages/schemas/src/audit.ts`, mirrored by
 * `node scripts/sync-edge-schemas.mjs`) and are re-exported so every existing
 * importer of this module is unchanged. The import path MUST stay relative —
 * `edge-bare-specifier.spec.ts` fails the build on a bare specifier, and the
 * edge runtime is given no import map. Before the list was centralised, the
 * copy here (11 actions), the SQL CHECK (23) and the dashboard's (24) had
 * silently diverged, and every `github_app.installation_linked` audit row was
 * dropped by the CHECK.
 *
 * `userId` is auth-type-sensitive, and the two edge surfaces resolve it
 * DIFFERENTLY today:
 *
 *   - REST (`_shared/api/auth.ts` `auditUserId`): the resolved user for BOTH
 *     `api_key` and user-JWT callers; `null` only for service-role. A JWT
 *     caller's db client is the RLS-scoped one, and `rls_audit_log_insert`
 *     requires `user_id = auth.uid()` — so supplying that user's own id is
 *     exactly what makes the insert legal. It used to pass `null` there,
 *     which failed the policy and lost the row.
 *   - MCP (`mcp/auth.ts` `getUserId`): the resolved user for `api_key` only;
 *     `null` for service-role AND user-JWT. The JWT branch therefore still
 *     writes `user_id = null` through an RLS-scoped client, still fails the
 *     INSERT policy, and is still swallowed below. That is the remaining gap,
 *     and MCP is the side that should converge on the REST behaviour — not
 *     the reverse.
 *
 * Service-role and `api_key` callers use the service-role client (bypasses
 * RLS), so their inserts succeed regardless of `user_id`.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AUDIT_ACTIONS } from './schemas/audit.ts';
import type { AuditAction } from './schemas/audit.ts';

export { AUDIT_ACTIONS };
export type { AuditAction };

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
