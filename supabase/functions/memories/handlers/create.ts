import type { AuthContext } from '../../_shared/api/auth.ts';
import { actorUserId, auditUserId, keyRestriction } from '../../_shared/api/auth.ts';
import { created, tooManyRequests, badRequest, dryRun, forbidden } from '../../_shared/api/respond.ts';
import { firstDeniedScope } from '../../_shared/api/tenant.ts';
import { DRY_RUN_HEADER, isDryRunHeader } from '../../_shared/limits/dry-run.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { CreateMemoryBodySchema } from '../../_shared/schemas/memory.ts';
import { translateDbError } from '../../_shared/api/errors.ts';
import { parseCreatedAt, CreatedAtError } from '../../_shared/limits/created-at.ts';
import { parseOrigin, OriginError } from '../../_shared/provenance/origin.ts';
import { resolveKindHost } from '../../_shared/schemas/tags.ts';
import { recordAuditDeferred } from '../../_shared/audit/audit.ts';
import { recordCitations } from '../../_shared/telemetry/citations.ts';
import { CORRELATION_HEADER } from '../../_shared/api/router.ts';
import { parseCorrelationId } from '../../_shared/telemetry/usage-stats.ts';
import { embedOnWrite } from '../../_shared/embedding/embed-on-write.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/db/database.types.ts';

type RateLimitRow = Database['public']['Functions']['lorekit_check_rate_limit']['Returns'][number];

/**
 * The environment, snapshotted once per isolate.
 *
 * `Deno.env.toObject()` copies the WHOLE secret environment, and reading five
 * embedding variables did that on every `POST /memories` — including the
 * disabled path, which is the one that has to stay free. Secrets are fixed for
 * an isolate's lifetime, so a boot-time snapshot is the same value. `embedOnWrite`
 * keeps taking `env` as a parameter so it stays testable with an injected one.
 */
const ENV = Deno.env.toObject();

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
  // in exactly one place for both surfaces — `_shared/limits/created-at.ts`, the same
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
  // rules live once in `_shared/provenance/origin.ts` — the module mcp/tools.ts's
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
  // Early refusal for a NAMED scope outside the key's allowlist (00068): a
  // plain 403 beats an empty page, which reads as "there is nothing there".
  const deniedScope = firstDeniedScope(auth, [body.scope]);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  // AFTER the refusal, deliberately: a dry run reports what a real write would
  // do, so answering 200 for a scope the key may not write would be a dry run
  // that lies about the very thing it is asked to predict.
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
    // The calling key's restriction, BOTH axes (00068/00069). The RPC is the
    // last gate the edge cannot bypass — it runs on the service-role client, so
    // the `firstDeniedScope` refusal above is advisory — and the only place that
    // can see the scope→org binding a restricted key must not be auto-routed
    // through.
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
    p_key_org_access: keyRestriction(auth)?.orgAccess ?? 'all',
    p_key_org_ids: keyRestriction(auth)?.orgIds ?? [],
    // `.single()` because memory_write RETURNS TABLE — without it the traced
    // client resolves an array and the `row?.id` guard below always throws.
  }).single();

  if (error) {
    const mapped = translateDbError(error);
    if (mapped) return mapped.toResponse(cors);
    span.error(`DB: ${error.message}`);
    throw error;
  }

  // `memory_write` (migration 00075) returns the full display row directly —
  // it is the same row the INSERT/UPDATE just touched, in the same
  // statement — so the response is built from THIS result rather than a
  // trailing `SELECT … WHERE id = …`. That second round trip used to cost an
  // extra edge→PostgREST hop (~206ms server-side wait per the load-test
  // attribution) for SQL `pg_stat_statements` measured at single-digit ms —
  // see the migration's header for the full account.
  // `inserted` (migration 00011) discriminates a create from an update — the
  // same signal mcp/tools.ts's toolWrite audits on.
  type MemoryWriteRow = {
    id: string; created_at: string; inserted?: boolean; expires_at: string | null;
    scope: string; key: string; value: string; tags: string[] | null;
    source_agent: string | null; trigger: string | null; updated_at: string;
    archived_at: string | null; origin_repo: string | null; origin_branch: string | null;
    origin_commit: string | null; origin_pr: number | null; kind: string | null;
    host: string | null; seen_count: number | null;
  };
  const row = data as MemoryWriteRow | null;
  if (!row?.id) {
    span.error('memory_write returned no id');
    throw new Error('memory_write returned no id');
  }
  span.setAttributes({ 'lorekit.memory_id': row.id, 'lorekit.write.inserted': row.inserted !== false });
  const entry = {
    id: row.id, scope: row.scope, key: row.key, value: row.value, tags: row.tags ?? [],
    source_agent: row.source_agent, trigger: row.trigger, created_at: row.created_at,
    updated_at: row.updated_at, expires_at: row.expires_at, archived_at: row.archived_at,
    origin_repo: row.origin_repo, origin_branch: row.origin_branch, origin_commit: row.origin_commit,
    origin_pr: row.origin_pr, kind: row.kind, host: row.host, seen_count: row.seen_count ?? undefined,
  };

  // Queue the embedding. Returns synchronously and is a no-op unless embedding
  // is explicitly enabled AND a key is configured — see `embed-on-write.ts` for
  // why it backgrounds rather than awaits, and why it SKIPS rather than falling
  // back to awaiting when the runtime has no background hook.
  // `actorUserId(auth)` for the same reason every org RPC takes it: the api_key
  // tier reaches Postgres over a service-role connection where `auth.uid()` is
  // NULL, so the RPC's capability check would deny every call without an
  // explicit actor. The value is never taken from the request.
  embedOnWrite(db, span, { id: row.id, key: body.key, value: body.value }, ENV, actorUserId(auth));

  // Record which lessons this write CREDITS (migration 00107). Awaited, unlike
  // the embedding, because it is one cheap RPC and it returns the only number
  // that says how many citations resolved. `actorUserId(auth)` for the reason
  // above: the api_key tier reaches Postgres over a service-role connection
  // where `auth.uid()` is NULL, and the RPC's tenancy predicate is the only
  // thing keeping a citation inside its own account.
  //
  // The correlation id is read from the REQUEST HEADER, never from the body:
  // it is the same key `usage_events` records for this call, which is what lets
  // a citation join to the run `/usage/runs` already enumerates. Taking it from
  // the body would let a caller attribute its citations to somebody else's run.
  await recordCitations(db, span, {
    userId: actorUserId(auth),
    citingMemoryId: row.id,
    cited: body.cited,
    correlationId: parseCorrelationId(req.headers.get(CORRELATION_HEADER)),
  });

  // Audit AFTER the write succeeded. Same action/resource/target/metadata
  // shape as toolWrite, so the MCP and REST surfaces produce comparable rows.
  // recordAudit never throws, so a failed audit cannot fail the request.
  //
  // DEFERRED, so the insert is not a round trip on the response path: its
  // result is `void` and unactionable, and the write it records has already
  // committed. On the edge the await below resolves immediately and the insert
  // finishes under `EdgeRuntime.waitUntil`; on a runtime without that hook it
  // degrades to the awaited behaviour rather than dropping the row. See
  // `_shared/audit/audit.ts` → `recordAuditDeferred` for why that fallback differs
  // from `embed-on-write.ts`'s deliberate skip.
  await recordAuditDeferred(
    db,
    {
      action: row.inserted === false ? 'memory.update' : 'memory.create',
      resourceType: 'memory',
      resourceId: row.id,
      target: body.key,
      metadata: { scope: body.scope, key: body.key },
    },
    auditUserId(auth),
    span,
  );
  return created(entry, cors);
}
