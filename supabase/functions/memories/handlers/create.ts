import type { AuthContext } from '../../_shared/api/auth.ts';
import { auditUserId } from '../../_shared/api/auth.ts';
import { created, tooManyRequests, badRequest, dryRun } from '../../_shared/api/respond.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/dry-run.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import { CreateMemoryBodySchema } from '../../_shared/schemas/memory.ts';
import { translateDbError } from '../../_shared/api/errors.ts';
import { parseCreatedAt, CreatedAtError } from '../../_shared/created-at.ts';
import { parseOrigin, OriginError } from '../../_shared/origin.ts';
import { resolveKindHost } from '../../_shared/schemas/tags.ts';
import { recordAudit } from '../../_shared/audit.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/database.types.ts';

type RateLimitRow = Database['public']['Functions']['lorekit_check_rate_limit']['Returns'][number];

export async function handleCreate(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = await validateBody(req, CreateMemoryBodySchema, cors);
  if (!v.ok) return v.response;
  const body = v.data;

  span.setAttributes({ 'lorekit.operation': 'memories.create', 'lorekit.scope': body.scope, 'lorekit.key': body.key });

  // Optional creation-date override (the `lorekit migrate` backdating case).
  // `CreateMemoryBodySchema` only types it as a string; the SEMANTIC rule
  // (parseable, not in the future beyond a 60s skew, normalised to ISO) lives
  // in exactly one place for both surfaces — `_shared/created-at.ts`, the same
  // module `mcp/tools.ts`'s toolWrite calls. An invalid value is a client
  // error: a 400 naming the problem, never a silent drop and never a 500.
  let createdAtOverride: string | null;
  try {
    createdAtOverride = parseCreatedAt(body.created_at);
  } catch (err) {
    if (err instanceof CreatedAtError) return badRequest(err.message, undefined, cors);
    throw err;
  }
  if (createdAtOverride) span.setAttributes({ 'lorekit.created_at': createdAtOverride });

  // Taxonomy: explicit kind/host from the body, else inferred from the loop
  // tag — the same resolution the MCP surface applies, so REST and MCP writes
  // classify a bucket identically.
  const { kind, host } = resolveKindHost(body);
  if (kind) span.setAttributes({ 'lorekit.kind': kind });
  if (host) span.setAttributes({ 'lorekit.host': host });

  // Optional provenance (repo / branch / commit / PR the write came from).
  // Same posture as created_at: the schema only types the fields, the SEMANTIC
  // rules live once in `_shared/origin.ts` — the module mcp/tools.ts's
  // toolWrite calls — and a malformed value is a 400 naming the problem rather
  // than a silently dropped origin.
  let origin;
  try {
    origin = parseOrigin(body);
  } catch (err) {
    if (err instanceof OriginError) return badRequest(err.message, undefined, cors);
    throw err;
  }

  // Rate limit check — exempt service-role callers (userId is null for service auth).
  if (auth.userId) {
    const rlSpan = span.child('lorekit.rest.rate_limit');
    const tracedRl = createTracedClient(db, rlSpan);
    const { data: rlData } = await tracedRl.rpc<RateLimitRow>('lorekit_check_rate_limit', { p_user_id: auth.userId, p_window_seconds: 60 });
    const rows = rlData as RateLimitRow[] | null;
    const row = Array.isArray(rows) ? rows[0] : null;
    rlSpan.setAttributes({ 'rate_limit.allowed': !!row?.allowed, 'rate_limit.current': row?.current_count ?? 0 }).end();
    if (row && !row.allowed) return tooManyRequests(row.retry_after_seconds ?? 60, cors);
  }

  // Dry-run: validated + rate-limited above; stop before any write.
  if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);

  // Use memory_write RPC rather than raw .upsert() — the memories table uses
  // partial unique indexes (WHERE archived_at IS NULL) introduced in migration
  // 00003, which PostgREST's upsert(onConflict) cannot target. The RPC handles
  // the conflict correctly, including archived-row resurrection.
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc('memory_write', {
    p_user_id: auth.type !== 'service' ? (auth.userId ?? null) : null,
    p_scope: body.scope,
    p_key: body.key,
    p_value: body.value,
    p_tags: body.tags ?? [],
    p_source_agent: body.source_agent ?? null,
    p_trigger: body.trigger ?? null,
    p_created_at: createdAtOverride,
    p_org_slug: body.org ?? null,
    // Migration 00038 replaced p_ttl_days with p_ttl_seconds. PostgREST resolves
    // an RPC by argument NAME, so sending the old name misses the function
    // entirely (PGRST202) — which surfaces as an opaque 500, not a 404.
    // `ttl_days` stays the REST field name (CreateMemoryBodySchema bounds it to
    // an integer 1–365); the days→seconds conversion happens here, exactly as
    // mcp/tools.ts and mcp-core's write.ts normalise via parseTtl().
    p_ttl_seconds: body.ttl_days != null ? body.ttl_days * 86_400 : null,
    p_clear_ttl: body.clear_ttl ?? false,
    p_origin_repo: origin.repo,
    p_origin_branch: origin.branch,
    p_origin_commit: origin.commit,
    p_origin_pr: origin.pr,
    p_kind: kind,
    p_host: host,
    // `.single()` because memory_write RETURNS TABLE — without it the traced
    // client resolves an array and the `row?.id` guard below always throws.
  }).single();

  if (error) {
    const mapped = translateDbError(error);
    if (mapped) return mapped.toResponse(cors);
    span.error(`DB: ${error.message}`);
    throw error;
  }

  // Fetch the full row so the response matches MemoryEntrySchema.
  // `inserted` (migration 00011) discriminates a create from an update — the
  // same signal mcp/tools.ts's toolWrite audits on.
  const row = data as { id: string; created_at: string; inserted?: boolean; expires_at?: string | null } | null;
  if (!row?.id) {
    span.error('memory_write returned no id');
    throw new Error('memory_write returned no id');
  }
  const { data: entry, error: fetchErr } = await createTracedClient(db, span)
    .from('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at,origin_repo,origin_branch,origin_commit,origin_pr,kind,host,seen_count')
    .eq('id', row.id)
    .single();

  if (fetchErr) { span.error(`DB: ${fetchErr.message}`); throw fetchErr; }
  span.setAttributes({ 'lorekit.memory_id': row.id, 'lorekit.write.inserted': row.inserted !== false });

  // Audit AFTER the write succeeded. Same action/resource/target/metadata
  // shape as toolWrite, so the MCP and REST surfaces produce comparable rows.
  // recordAudit never throws, so a failed audit cannot fail the request.
  await recordAudit(
    db,
    {
      action: row.inserted === false ? 'memory.update' : 'memory.create',
      resourceType: 'memory',
      resourceId: row.id,
      target: body.key,
      metadata: { scope: body.scope, key: body.key },
    },
    auditUserId(auth),
  );
  return created(entry, cors);
}
