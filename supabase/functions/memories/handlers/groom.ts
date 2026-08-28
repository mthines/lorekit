import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { recordAudit } from '../../_shared/audit/audit.ts';
import { forbidden, ok, dryRun } from '../../_shared/api/respond.ts';
import { badRequest } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { GroomRequestSchema } from '../../_shared/schemas/retention.ts';
import { resolveGroomConditions } from '../../_shared/retention/groom.ts';
import type { RetentionPolicyRow, GroomRequestInput } from '../../_shared/retention/groom.ts';
import { RETENTION_POLICIES_ENABLED } from '../../_shared/retention/feature-flag.ts';
import type { DbClient } from '../../_shared/api/auth.ts';

/**
 * `POST /groom/preview` and `POST /groom/run` — the REST twins of the MCP
 * `groom.preview` / `groom.run` tools. Both accept a `policy_id` OR inline
 * conditions (`GroomRequestSchema`'s union) and resolve them through the SAME
 * `resolveGroomConditions` pure module the MCP handlers use, then call the
 * SAME candidate SQL (`lorekit_groom_candidates` / `lorekit_groom_run`) — so
 * a previewed count always equals what a run archives, on either surface.
 */
function requireUserId(auth: AuthContext, cors: Record<string, string>): string | Response {
  if (!RETENTION_POLICIES_ENABLED) {
    return forbidden('retention policies are not enabled for this instance', cors);
  }
  if (!auth.userId) {
    return forbidden('Grooming requires a user-scoped credential (service-role tokens have no owner)', cors);
  }
  return auth.userId;
}

interface RetentionPolicyDbRow {
  id: string;
  scope: string;
  mode: 'review' | 'auto';
  enabled: boolean;
  min_age_days: number | null;
  unseen_days: number | null;
  max_seen_count: number | null;
}

function toPolicyRow(row: RetentionPolicyDbRow): RetentionPolicyRow {
  return {
    id: row.id, scope: row.scope, mode: row.mode, enabled: row.enabled,
    min_age_days: row.min_age_days, unseen_days: row.unseen_days, max_seen_count: row.max_seen_count,
  };
}

async function resolveConditions(
  db: DbClient, span: Span, userId: string, request: GroomRequestInput,
): Promise<{ scope: string; min_age_days: number | null; unseen_days: number | null; max_seen_count: number | null } | { error: Response }> {
  let policy: RetentionPolicyRow | null = null;
  if ('policy_id' in request) {
    const tracedDb = createTracedClient(db, span);
    const { data, error } = await tracedDb.rpc('lorekit_policy_list', { p_user_id: userId });
    if (error) throw error;
    const row = ((data ?? []) as unknown as RetentionPolicyDbRow[]).find((r) => r.id === request.policy_id) ?? null;
    if (!row) return { error: badRequest(`no retention policy found for policy_id=${request.policy_id}`, undefined, {}) };
    policy = toPolicyRow(row);
  }
  return resolveGroomConditions(request, policy);
}

/** POST /groom/preview — the candidates a policy or inline conditions would archive. */
export async function handleGroomPreview(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  const v = await validateBody(req, GroomRequestSchema, cors);
  if (!v.ok) return v.response;

  const resolved = await resolveConditions(db, span, userId, v.data as GroomRequestInput);
  if ('error' in resolved) return resolved.error;
  const conditions = resolved;
  span.setAttributes({ 'lorekit.operation': 'memories.groom_preview', 'lorekit.scope': conditions.scope });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('lorekit_groom_candidates', {
    p_user_id: userId,
    p_scope: conditions.scope,
    p_min_age_days: conditions.min_age_days,
    p_unseen_days: conditions.unseen_days,
    p_max_seen_count: conditions.max_seen_count,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const rows = (data ?? []) as { id: string; scope: string; key: string }[];
  const keys = rows.map((r) => ({ scope: r.scope, key: r.key }));
  span.setAttributes({ 'lorekit.result.count': keys.length });
  return ok({ count: keys.length, keys }, cors);
}

/**
 * POST /groom/run — archive every matching candidate in one transaction.
 * Mirrors the MCP `groom.run` tool: same RPC, same audit shape (one
 * memory.archive row per archived lesson, written inside the RPC), never
 * deletes.
 */
export async function handleGroomRun(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const userId = requireUserId(auth, cors);
  if (typeof userId !== 'string') return userId;

  const v = await validateBody(req, GroomRequestSchema, cors);
  if (!v.ok) return v.response;

  const resolved = await resolveConditions(db, span, userId, v.data as GroomRequestInput);
  if ('error' in resolved) return resolved.error;
  const conditions = resolved;
  span.setAttributes({ 'lorekit.operation': 'memories.groom_run', 'lorekit.scope': conditions.scope });

  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb
    .rpc<{ archived: number; keys: { scope: string; key: string }[] }>('lorekit_groom_run', {
      p_user_id: userId,
      p_scope: conditions.scope,
      p_min_age_days: conditions.min_age_days,
      p_unseen_days: conditions.unseen_days,
      p_max_seen_count: conditions.max_seen_count,
    })
    .single();
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const row = data as { archived: number; keys: { scope: string; key: string }[] };
  span.setAttributes({ 'lorekit.result.archived': row.archived });

  // App-layer audit capture, matching the MCP groom.run tool exactly: one
  // memory.archive row per archived lesson, reusing the existing action
  // rather than minting memory.groom. lorekit_groom_run itself never writes
  // audit_log (LoreKit's capture model is app-layer, not DB-side).
  const actor = auditUserId(auth);
  for (const k of row.keys ?? []) {
    await recordAudit(
      db,
      { action: 'memory.archive', resourceType: 'memory', target: k.key, metadata: { scope: k.scope, key: k.key, via: 'groom.run' } },
      actor,
      span,
    );
  }

  return ok({ archived: row.archived, keys: row.keys ?? [] }, cors);
}
