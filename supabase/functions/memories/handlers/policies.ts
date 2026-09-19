import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId, keyRestriction } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit/audit.ts';
import { ok, notFound, dryRun, forbidden } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { PolicyCreateBodySchema, PolicyUpdateBodySchema } from '../../_shared/schemas/retention.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import { scopeAllowedByKey, narrowByKeyScope, keyScopeDeniedMessage } from '../../_shared/schemas/api-key.ts';

/**
 * `retention_policies` REST resource: `GET/POST /policies`,
 * `PATCH/DELETE /policies/:id`. v1 is personal-owned only, so every route
 * requires a resolved user (a service-role caller is a 403, matching the
 * purge endpoints' `requireUserId` rationale — the request is well-formed,
 * the CREDENTIAL cannot name an owner). CRUD is routed through the
 * `lorekit_policy_*` SECURITY DEFINER RPCs (00088) rather than a raw
 * `.from('retention_policies')` call — see `mcp/tools.ts`'s policy handlers
 * for the full rationale (shared by both surfaces).
 *
 * Every route also gates the calling key's scope allowlist (00068) against
 * the scope it resolves — `create` its target scope, `update`/`delete` the
 * pre-fetched STORED scope, `list` narrows its results — mirroring the MCP
 * `policy.*` tools' `assertScopeAllowed` gate via the SAME shared predicate
 * (`scopeAllowedByKey`/`narrowByKeyScope`), so a scope-restricted `lk_*` token
 * is refused/narrowed identically on both surfaces.
 */
function requireUserId(auth: AuthContext, cors: Record<string, string>): string | Response {
  if (!auth.userId) {
    return forbidden('Retention policies require a user-scoped credential (service-role tokens have no owner)', cors);
  }
  return auth.userId;
}

interface RetentionPolicyDbRow {
  id: string;
  user_id: string;
  scope: string;
  name: string;
  mode: 'review' | 'auto';
  enabled: boolean;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
  max_read_count: number | null;
  max_opened_count: number | null;
  tags: string[] | null;
  tags_mode: string | null;
  source_agent: string[] | null;
  source_agent_mode: string | null;
  trigger: string[] | null;
  trigger_mode: string | null;
  kind: string[] | null;
  kind_mode: string | null;
  host: string[] | null;
  host_mode: string | null;
  origin_repo: string[] | null;
  origin_repo_mode: string | null;
  origin_branch: string[] | null;
  origin_branch_mode: string | null;
  origin_pr: string[] | null;
  origin_pr_mode: string | null;
  created_at: string;
  updated_at: string;
}

function toWire(row: RetentionPolicyDbRow) {
  const { user_id: _userId, ...rest } = row;
  return rest;
}

/**
 * Fetch a single retention policy by id, owner-scoped, via the existing
 * `lorekit_policy_list` RPC (no per-id fetch RPC exists — mirrors `mcp/
 * tools.ts`'s `findPolicyRow`). Returns `null` when no such policy exists for
 * this owner.
 *
 * The pre-fetch behind `handlePolicyUpdate`/`handlePolicyDelete`'s gate on the
 * STORED scope: the mutation RPCs commit before returning the row, so gating
 * on the RETURNED row would be post-commit — a mutation leak, not fail-closed.
 */
async function findPolicyRow(
  db: DbClient, span: Span, userId: string, id: string,
): Promise<RetentionPolicyDbRow | null> {
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_policy_list', { p_user_id: userId });
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  return ((data ?? []) as unknown as RetentionPolicyDbRow[]).find((r) => r.id === id) ?? null;
}

/** GET /policies — list every retention policy the caller owns. */
export async function handlePolicyList(
  _req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  span.setAttributes({ 'lorekit.operation': 'memories.policy_list' });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_policy_list', { p_user_id: userId });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const restriction = keyRestriction(auth);
  const rows = narrowByKeyScope(restriction?.scopes ?? [], (data ?? []) as unknown as RetentionPolicyDbRow[]);
  const entries = rows.map(toWire);
  span.setAttributes({ 'lorekit.result.count': entries.length });
  return ok({ entries }, cors);
}

/** POST /policies — create a retention policy. */
export async function handlePolicyCreate(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  const v = await validateBody(req, PolicyCreateBodySchema, cors);
  if (!v.ok) return v.response;
  const body = v.data;

  span.setAttributes({ 'lorekit.scope': body.scope, 'lorekit.policy.mode': body.mode });

  const restriction = keyRestriction(auth);
  if (restriction && restriction.scopes.length > 0 && !scopeAllowedByKey(restriction.scopes, body.scope)) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(keyScopeDeniedMessage(body.scope), cors);
  }

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc<RetentionPolicyDbRow>('lorekit_policy_create', {
      p_user_id: userId,
      p_scope: body.scope,
      p_name: body.name,
      p_mode: body.mode,
      p_enabled: body.enabled,
      p_min_age_days: body.min_age_days ?? null,
      p_unseen_days: body.unseen_days ?? null,
      p_max_seen_count: body.max_seen_count ?? null,
      p_max_read_count: body.max_read_count ?? null,
      p_max_opened_count: body.max_opened_count ?? null,
      // The eight dimension filters (migration 00093) — same field names as
      // the Explorer's own `POST /memories/list` body, so a `Filter[]` bar
      // translated by `filtersToGroomConditions` needs no re-mapping here.
      p_tags: body.tags ?? null,
      p_tags_mode: body.tags_mode ?? 'any',
      p_source_agent: body.source_agent ?? null,
      p_source_agent_mode: body.source_agent_mode ?? 'in',
      p_trigger: body.trigger ?? null,
      p_trigger_mode: body.trigger_mode ?? 'in',
      p_kind: body.kind ?? null,
      p_kind_mode: body.kind_mode ?? 'in',
      p_host: body.host ?? null,
      p_host_mode: body.host_mode ?? 'in',
      p_origin_repo: body.origin_repo ?? null,
      p_origin_repo_mode: body.origin_repo_mode ?? 'in',
      p_origin_branch: body.origin_branch ?? null,
      p_origin_branch_mode: body.origin_branch_mode ?? 'in',
      p_origin_pr: body.origin_pr ?? null,
      p_origin_pr_mode: body.origin_pr_mode ?? 'in',
    })
    .single();
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const row = data as RetentionPolicyDbRow;
  await recordAudit(
    db,
    { action: 'policy.create', resourceType: 'retention_policy', resourceId: row.id, target: row.name, metadata: { scope: row.scope, mode: row.mode, enabled: row.enabled } },
    auditUserId(auth),
    span,
  );
  return ok(toWire(row), cors);
}

/** PATCH /policies/:id — update a retention policy; every field optional. */
export async function handlePolicyUpdate(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  const v = await validateBody(req, PolicyUpdateBodySchema, cors);
  if (!v.ok) return v.response;
  const patch = v.data;

  span.setAttributes({ 'lorekit.policy.id': params.id });

  // Fail-closed: pre-fetch the STORED scope (immutable — not a patch field)
  // and gate it BEFORE the mutation RPC. A missing id is left to the RPC's
  // own not-found path below — unchanged by this gate.
  const existing = await findPolicyRow(db, span, userId, params.id);
  if (existing) {
    const restriction = keyRestriction(auth);
    if (restriction && restriction.scopes.length > 0 && !scopeAllowedByKey(restriction.scopes, existing.scope)) {
      span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
      return forbidden(keyScopeDeniedMessage(existing.scope), cors);
    }
  }

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('lorekit_policy_update', { p_user_id: userId, p_id: params.id, p_patch: patch });
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const row = ((data ?? []) as unknown as RetentionPolicyDbRow[])[0] ?? null;
  if (!row) return notFound('Retention policy', cors);

  await recordAudit(
    db,
    { action: 'policy.update', resourceType: 'retention_policy', resourceId: row.id, target: row.name, metadata: patch },
    auditUserId(auth),
    span,
  );
  return ok(toWire(row), cors);
}

/** DELETE /policies/:id — delete the RULE only; never touches memories. */
export async function handlePolicyDelete(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  span.setAttributes({ 'lorekit.policy.id': params.id });

  // Fail-closed: pre-fetch the STORED scope and gate BEFORE the mutation RPC
  // (see handlePolicyUpdate). A missing id is left to the RPC's own
  // `notFound` path below — unchanged by this gate.
  const existing = await findPolicyRow(db, span, userId, params.id);
  if (existing) {
    const restriction = keyRestriction(auth);
    if (restriction && restriction.scopes.length > 0 && !scopeAllowedByKey(restriction.scopes, existing.scope)) {
      span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
      return forbidden(keyScopeDeniedMessage(existing.scope), cors);
    }
  }

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc('lorekit_policy_delete', { p_user_id: userId, p_id: params.id });
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const row = ((data ?? []) as unknown as RetentionPolicyDbRow[])[0] ?? null;
  if (!row) return notFound('Retention policy', cors);

  await recordAudit(
    db,
    { action: 'policy.delete', resourceType: 'retention_policy', resourceId: row.id, target: row.name, metadata: { scope: row.scope } },
    auditUserId(auth),
    span,
  );
  return ok({ deleted: true }, cors);
}
