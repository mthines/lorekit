/**
 * Append-only audit trail for security/data-affecting actions across LoreKit:
 * API-key lifecycle, webhook-secret changes, memory mutations, org/membership
 * management, and limit overrides (supabase/migrations/00010_audit_log.sql,
 * widened by 00023 / 00027 / 00040).
 *
 * THIS IS THE CANONICAL Deno audit writer. It lives in `_shared/` — not in
 * `mcp/` — because both production surfaces need it: the MCP tools
 * (`mcp/tools.ts`, via the thin re-export in `mcp/audit.ts`) and the REST
 * handlers (`memories/handlers/*`, `orgs/handlers/**`, via `recordRestAudit`).
 * `mcp/` already cross-imports `_shared/otel.ts`, so there is no isolation
 * boundary being crossed here; keeping two copies only invited drift.
 *
 * Layering, mirroring the limits.ts / created-at.ts convention:
 *   - buildAuditEntry(input)              — pure: shapes the audit_log row.
 *   - recordAudit(db, input, userId)      — impure shell: inserts the row,
 *     NEVER throws.
 *   - recordRestAudit(db, span, auth, in) — REST wrapper: resolves the actor
 *     from the REST AuthContext, wraps the insert in its own child span, and
 *     NEVER throws.
 *
 * The action vocabulary and the three types are NOT declared here. They come
 * from `@lorekit/schemas/audit`, the single source of truth shared by this
 * writer, the Node writer (`packages/mcp-core/src/audit.ts`), the dashboard
 * (`packages/web/src/lib/audit-actions.ts`) and — restated in SQL, drift-guarded
 * by `packages/mcp-core/src/audit-actions-drift.spec.ts` — the `audit_log.action`
 * CHECK constraint.
 *
 * CAPTURE MODEL (Decision D1): every action here is recorded by an explicit
 * app-layer call right after its primary operation succeeds — NOT by a DB
 * trigger on the data tables. The one deliberate exception (Decision D2) is
 * `limit.override`: no app-layer path writes `user_limits` today, so a DB
 * trigger (`audit_user_limits()`, in the 00010 migration) is the only way to
 * capture it. See CLAUDE.md "Key decisions" for the full rationale.
 */
import type { AuditAction, AuditEntryInput, AuditRow } from '@lorekit/schemas/audit';
import type { Span } from './otel.ts';
import type { AuthContext, DbClient } from './api/auth.ts';

/**
 * TYPE-ONLY import of the schemas module, deliberately. `AuditActionSchema` and
 * the runtime `AUDIT_ACTIONS` tuple are never needed here: `action` is already
 * constrained at compile time by the `AuditAction` union, and re-validating it
 * at runtime would only turn a type error into a swallowed insert failure. The
 * payoff is that `mcp` — which imports no zod today — does not gain the whole
 * zod runtime in its edge bundle just to reach this writer. The TS↔SQL
 * vocabulary tie is enforced by `audit-actions-drift.spec.ts` in Node, where it
 * costs nothing at request time.
 *
 * Every import in this module is `import type`, so the whole file erases to its
 * two functions with no runtime dependencies at all — `DbClient` is the same
 * `ReturnType<typeof createClient>` alias `api/auth.ts` already exports, so
 * naming it here costs nothing and avoids importing supabase-js purely to write
 * a type.
 */
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
  db: DbClient,
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
 * Record one audit event from a REST handler.
 *
 * CALL THIS **AFTER** THE PRIMARY OPERATION HAS SUCCEEDED — never on an error,
 * 404, 403 or zero-rows-matched path. An audit row asserts that something
 * happened; emitting one for an operation that did not happen is worse than
 * emitting none. Concretely: audit after the RPC/query returns without error
 * AND (where the operation can no-op) after confirming it actually matched a
 * row.
 *
 * IT NEVER THROWS, and a caller must never make its response conditional on it.
 * `recordAudit` already swallows insert errors; this wrapper additionally
 * guards the span bookkeeping, so even a telemetry fault cannot turn a
 * successful mutation into a 500.
 *
 * ACTOR RESOLUTION differs meaningfully from the MCP path. `AuthContext.userId`
 * is populated for JWT users here, whereas MCP's `getUserId` returns null for
 * them — so REST audits a dashboard/CLI JWT call with the real actor. That
 * matters because the `audit_log` INSERT policy requires `user_id = auth.uid()`
 * and the `type: 'user'` db client is RLS-scoped: the two agree, so the insert
 * succeeds. For `api_key` the resolved token owner is used and the client is
 * service-role (bypasses RLS); for `service` there is no actor at all and the
 * row is written with `user_id = null`, again under service-role.
 *
 * The insert gets its own `lorekit.rest.audit` child span (the same shape as
 * `lorekit.rest.auth` and `lorekit.rest.rate_limit`) so audit latency is
 * attributable separately from the mutation it follows — an audit write that
 * starts costing 200ms should be visible without being mistaken for a slow
 * write. `lorekit.audit.action` is a bounded attribute: its value is always one
 * of the 24 `AUDIT_ACTIONS`, so it is safe as a metric/trace dimension.
 *
 * @example
 * ```typescript
 * // memories/handlers/create.ts — after the write succeeded and we have the id
 * await recordRestAudit(db, span, auth, {
 *   action: row.inserted === false ? 'memory.update' : 'memory.create',
 *   resourceType: 'memory',
 *   resourceId: row.id,
 *   target: body.key,
 *   metadata: { scope: body.scope, key: body.key },
 * });
 * return created(entry, cors);
 * ```
 */
export async function recordRestAudit(
  db: DbClient,
  span: Span,
  auth: AuthContext,
  input: AuditEntryInput,
): Promise<void> {
  const auditSpan = span.child('lorekit.rest.audit', { 'lorekit.audit.action': input.action });
  try {
    await recordAudit(db, input, auth.userId ?? null);
  } catch (err) {
    // recordAudit is already total; this is belt-and-braces so a future change
    // to it can never propagate an exception into a completed mutation.
    console.error(`[recordRestAudit] unexpected error for action=${input.action}:`, (err as Error).message);
  } finally {
    auditSpan.end();
  }
}
