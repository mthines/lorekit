import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit/audit.ts';
import { ok, notFound, dryRun, forbidden } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { PolicyCreateBodySchema, PolicyUpdateBodySchema } from '../../_shared/schemas/retention.ts';
import { RETENTION_POLICIES_ENABLED } from '../../_shared/retention/feature-flag.ts';
import type { DbClient } from '../../_shared/api/auth.ts';

/**
 * `retention_policies` REST resource: `GET/POST /policies`,
 * `PATCH/DELETE /policies/:id`. v1 is personal-owned only, so every route
 * requires a resolved user (a service-role caller is a 403, matching the
 * purge endpoints' `requireUserId` rationale — the request is well-formed,
 * the CREDENTIAL cannot name an owner). CRUD is routed through the
 * `lorekit_policy_*` SECURITY DEFINER RPCs (00079) rather than a raw
 * `.from('retention_policies')` call — see `mcp/tools.ts`'s policy handlers
 * for the full rationale (shared by both surfaces).
 */
function requireUserId(auth: AuthContext, cors: Record<string, string>): string | Response {
  if (!RETENTION_POLICIES_ENABLED) {
    return forbidden('retention policies are not enabled for this instance', cors);
  }
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
  created_at: string;
  updated_at: string;
}

function toWire(row: RetentionPolicyDbRow) {
  const { user_id: _userId, ...rest } = row;
  return rest;
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

  const entries = ((data ?? []) as unknown as RetentionPolicyDbRow[]).map(toWire);
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
