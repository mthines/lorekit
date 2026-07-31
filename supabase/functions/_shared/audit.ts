/**
 * Append-only audit trail for security/data-affecting actions across LoreKit:
 * API-key lifecycle, webhook-secret changes, memory mutations, and limit
 * overrides (supabase/migrations/00010_audit_log.sql).
 *
 * THE single audit writer for the whole edge tree. It lives in `_shared/`
 * (not `mcp/`) because both surfaces use it: the MCP tools
 * (`supabase/functions/mcp/tools.ts`) and the REST handlers
 * (`supabase/functions/memories/handlers/*.ts` and
 * `supabase/functions/orgs/handlers/**`). There must never be a second edge
 * audit writer — the two surfaces must produce comparable rows.
 *
 * `recordRestAudit` (bottom of this file) is a thin REST-facing WRAPPER around
 * `recordAudit`, not a second writer: it resolves the actor from an
 * `AuthContext` and delegates the insert. It is the one member of this module
 * with no counterpart in the Node mirror, because `AuthContext`/`Span` are edge
 * concepts that do not exist in `@lorekit/core`. Everything above it —
 * `AUDIT_ACTIONS`, the types, `buildAuditEntry`, `recordAudit` — stays
 * line-for-line identical to the mirror apart from the import lines.
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
import { auditUserId } from './api/auth.ts';
import type { AuthContext, DbClient } from './api/auth.ts';
import type { Span } from './otel.ts';

/**
 * The bounded audit vocabulary. This list MUST equal — same values, same
 * order — the `audit_log_action_check` CHECK constraint as last (re)defined by
 * `supabase/migrations/00042_audit_log_rest_org_actions.sql`, and the
 * independently re-declared union in `packages/web/src/lib/audit-actions.ts`.
 * An action the CHECK rejects is silent audit loss: `recordAudit` never throws,
 * so Postgres' rejection is logged and swallowed. Widen the CHECK with a new
 * forward-only migration first, then this list, then the web union.
 */
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
  'org.create',
  'org.rename',
  'org.delete',
  'member.invite',
  'member.accept',
  'member.decline',
  'member.revoke',
  'member.remove',
  'member.role_change',
  'member.leave',
  'scope.bind',
  'scope.unbind',
  'github_app.installation_linked',
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

/**
 * The REST-facing convenience wrapper around {@link recordAudit}.
 *
 * A REST handler holds an `AuthContext`, not a resolved actor id, and every
 * handler resolving that id itself is exactly how the two surfaces drift. This
 * takes the context and resolves the actor through the ONE existing helper,
 * `auditUserId` (`_shared/api/auth.ts`) — the rule is never re-derived here.
 * The insert itself is delegated to `recordAudit`; this adds no second write
 * path, so there remains exactly one edge audit writer.
 *
 * It also opens a `lorekit.rest.audit` child span, so an audit write is
 * attributable in a trace instead of being an invisible tail latency on the
 * handler's own span.
 *
 * NEVER THROWS — it inherits that guarantee from `recordAudit` (whose body is
 * wholly wrapped in try/catch) and adds nothing outside it that can reject:
 * `auditUserId` is total and the span is ended in a `finally`.
 *
 * KNOWN LIMITATION, MIRRORED ON PURPOSE: on the JWT (`type: 'user'`) path
 * `auditUserId` returns `null`, even though `auth.userId` is populated. The
 * JWT client is RLS-scoped and `audit_log`'s INSERT policy requires
 * `user_id = auth.uid()`, so a null actor fails RLS and the insert is silently
 * swallowed. That is the deliberate mirror of MCP's `getUserId` behaviour
 * (documented at the top of this file and on `auditUserId`), NOT a bug
 * introduced by the REST handlers: changing it is one cross-surface decision
 * spanning MCP, REST and the RLS policy, not a per-handler one. `api_key` and
 * `service` callers use the service-role client, which bypasses RLS, so their
 * rows always land — and `api_key` is precisely the tier the org routes were
 * opened to by `00041_org_actor_override.sql`.
 */
export async function recordRestAudit(
  db: DbClient,
  span: Span,
  auth: AuthContext,
  input: AuditEntryInput,
): Promise<void> {
  const auditSpan = span.child('lorekit.rest.audit');
  try {
    auditSpan.setAttributes({ 'lorekit.audit.action': input.action });
    await recordAudit(db, input, auditUserId(auth));
  } finally {
    auditSpan.end();
  }
}
