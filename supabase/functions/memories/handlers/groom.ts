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
import type { RetentionPolicyRow, GroomRequestInput, GroomConditions } from '../../_shared/retention/groom.ts';
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
  max_read_count: number | null;
  max_opened_count: number | null;
  tags: string[] | null;
  tags_mode: RetentionPolicyRow['tags_mode'];
  source_agent: string[] | null;
  source_agent_mode: RetentionPolicyRow['source_agent_mode'];
  trigger: string[] | null;
  trigger_mode: RetentionPolicyRow['trigger_mode'];
  kind: string[] | null;
  kind_mode: RetentionPolicyRow['kind_mode'];
  host: string[] | null;
  host_mode: RetentionPolicyRow['host_mode'];
  origin_repo: string[] | null;
  origin_repo_mode: RetentionPolicyRow['origin_repo_mode'];
  origin_branch: string[] | null;
  origin_branch_mode: RetentionPolicyRow['origin_branch_mode'];
  origin_pr: string[] | null;
  origin_pr_mode: RetentionPolicyRow['origin_pr_mode'];
}

function toPolicyRow(row: RetentionPolicyDbRow): RetentionPolicyRow {
  return {
    id: row.id, scope: row.scope, mode: row.mode, enabled: row.enabled,
    min_age_days: row.min_age_days, unseen_days: row.unseen_days, max_seen_count: row.max_seen_count,
    max_read_count: row.max_read_count,
    max_opened_count: row.max_opened_count,
    tags: row.tags, tags_mode: row.tags_mode,
    source_agent: row.source_agent, source_agent_mode: row.source_agent_mode,
    trigger: row.trigger, trigger_mode: row.trigger_mode,
    kind: row.kind, kind_mode: row.kind_mode,
    host: row.host, host_mode: row.host_mode,
    origin_repo: row.origin_repo, origin_repo_mode: row.origin_repo_mode,
    origin_branch: row.origin_branch, origin_branch_mode: row.origin_branch_mode,
    origin_pr: row.origin_pr, origin_pr_mode: row.origin_pr_mode,
  };
}

async function resolveConditions(
  db: DbClient, span: Span, userId: string, request: GroomRequestInput,
): Promise<GroomConditions | { error: Response }> {
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

/**
 * `lorekit_groom_candidates` and `lorekit_groom_run` take IDENTICAL
 * parameters (00093's `lorekit_groom_run` is a thin wrapper that forwards to
 * the former) — one place to build the RPC args so `handleGroomPreview` and
 * `handleGroomRun` cannot drift on which fields they send.
 */
function groomConditionsRpcParams(userId: string, conditions: GroomConditions) {
  return {
    p_user_id: userId,
    p_scope: conditions.scope,
    p_min_age_days: conditions.min_age_days,
    p_unseen_days: conditions.unseen_days,
    p_max_seen_count: conditions.max_seen_count,
    p_max_read_count: conditions.max_read_count,
    p_max_opened_count: conditions.max_opened_count,
    p_tags: conditions.tags,
    p_tags_mode: conditions.tags_mode ?? 'any',
    p_source_agent: conditions.source_agent,
    p_source_agent_mode: conditions.source_agent_mode ?? 'in',
    p_trigger: conditions.trigger,
    p_trigger_mode: conditions.trigger_mode ?? 'in',
    p_kind: conditions.kind,
    p_kind_mode: conditions.kind_mode ?? 'in',
    p_host: conditions.host,
    p_host_mode: conditions.host_mode ?? 'in',
    p_origin_repo: conditions.origin_repo,
    p_origin_repo_mode: conditions.origin_repo_mode ?? 'in',
    p_origin_branch: conditions.origin_branch,
    p_origin_branch_mode: conditions.origin_branch_mode ?? 'in',
    p_origin_pr: conditions.origin_pr,
    p_origin_pr_mode: conditions.origin_pr_mode ?? 'in',
  };
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
  const { data, error } = await tracedDb.rpc('lorekit_groom_candidates', groomConditionsRpcParams(userId, conditions));
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
    .rpc<{ archived: number; keys: { scope: string; key: string }[] }>(
      'lorekit_groom_run',
      groomConditionsRpcParams(userId, conditions),
    )
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
