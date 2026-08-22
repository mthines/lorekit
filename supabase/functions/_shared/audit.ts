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
 * mcp-core vs `DbClient` off the `npm:` specifier
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
import { background } from './background.ts';
import { AUDIT_ACTIONS } from './schemas/audit.ts';
import type { AuditAction } from './schemas/audit.ts';
import type { DbClient } from './db-client.ts';
import type { Json } from './database.types.ts';

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
  db: DbClient,
  input: AuditEntryInput,
  userId: string | null,
): Promise<void> {
  try {
    const row = buildAuditEntry(input);
    const { error } = await db.from('audit_log').insert({
      ...row,
      user_id: userId,
      // `AuditRow.metadata` is `Record<string, unknown> | null` — the CALLER's
      // shape, shared with packages/mcp-core/src/audit.ts — while the generated
      // Insert type wants `Json`. The value is JSON-serialisable by contract (it
      // goes straight into a jsonb column), so state that here rather than
      // widening AuditRow, which should keep describing what callers may pass.
      metadata: row.metadata as Json,
    });
    if (error) {
      console.error(`[recordAudit] insert failed for action=${input.action}:`, error.message);
    }
  } catch (err) {
    console.error(`[recordAudit] unexpected error for action=${input.action}:`, (err as Error).message);
  }
}

/**
 * `recordAudit`, taken OFF the response path.
 *
 * WHY THIS EXISTS
 * `recordAudit` is called after the primary operation has already committed,
 * and it returns `void` and never throws — so no caller can act on its result.
 * Awaiting it therefore bought nothing and cost a full edge→PostgREST round
 * trip on every mutation's response path. In the 2026-08-22 load test
 * (run 32588442998) a REST write's p50 was 1120 ms against ~534 ms for a read,
 * while ALL server-side SQL in the window totalled 11.75 ms per request — so
 * the write penalty was round trips, not queries, and this is one of them.
 *
 * WHY IT FALLS BACK TO AWAITING, unlike `embed-on-write.ts`
 * That module deliberately SKIPS when `waitUntil` is unavailable, because a
 * missing embedding is recovered by the backfill (`embedding is null`). An
 * audit row has no backfill: it is the only record that the action happened,
 * and D1 (see the module header) makes the app layer solely responsible for
 * writing it. Dropping one to save latency would trade a durability guarantee
 * for a performance one, so on a runtime with no hook this returns the real
 * promise and the caller's `await` behaves exactly as it did before.
 *
 * Callers therefore keep writing `await recordAuditDeferred(…)`: on the edge
 * the await resolves immediately and the insert completes in the background;
 * anywhere else it is today's behaviour, unchanged.
 *
 * ONE BEHAVIOURAL CHANGE worth knowing: the audit row is no longer guaranteed
 * to be visible by the time the mutation's response reaches the client. Nothing
 * reads it that way — the Audit Logs UI and `GET /audit` are review surfaces,
 * not read-after-write consumers — but a test that mutates and then immediately
 * asserts on `audit_log` would become racy, and should poll rather than assume.
 */
export function recordAuditDeferred(
  db: DbClient,
  input: AuditEntryInput,
  userId: string | null,
): Promise<void> {
  const p = recordAudit(db, input, userId);
  const rt = background();
  if (!rt) return p;
  rt.waitUntil(p);
  return Promise.resolve();
}
