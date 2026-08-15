import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/database.types.ts';
import { ActivityQuerySchema } from '../../_shared/schemas/memory.ts';
import { parseTagsParam } from '../../_shared/schemas/tags.ts';

type ActivityRow = Database['public']['Functions']['lorekit_memory_activity']['Returns'][number];

/**
 * How far back a bare call looks. Long enough to cover the dashboard's widest
 * chart (30 daily buckets plus the 30 preceding it, for the period-over-period
 * comparison) and the contribution heatmap's 26 weeks, with headroom.
 *
 * The window is bounded by default on purpose: an unbounded aggregate over
 * `memories` grows with account age, and no caller today wants "all time".
 */
const DEFAULT_WINDOW_DAYS = 200;
const DAY_MS = 86_400_000;

/**
 * GET /memories/activity — memories created per UTC hour/day per scope over a
 * half-open `[since, until)` window.
 *
 * The dashboard's stat cards and contribution heatmap need "how many memories,
 * when, in which scope". They used to answer it by selecting up to 1000 raw
 * `(scope, created_at)` rows and bucketing them in the browser — truncated
 * without warning past PostgREST's cap (so old activity silently disappeared
 * from the heatmap) and a payload proportional to memory count rather than to
 * the ~60 numbers actually rendered.
 *
 * `date_trunc` in the RPC anchors each bucket at the START of the UTC hour/day,
 * which is exactly where the client's own bucket boundaries fall, so a client
 * tallying these rows gets the same figures it got from raw rows.
 *
 * Tenant scoping lives in the RPC (`lorekit_memory_activity`, migration 00051)
 * for the same reason as `handleScopes` / `handleTags`.
 */
export async function handleActivity(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ActivityQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  const until = params.until ?? new Date().toISOString();
  const since = params.since ?? new Date(Date.parse(until) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();

  span.setAttributes({
    'lorekit.operation': 'memories.activity',
    'lorekit.bucket': params.bucket,
    ...(params.scope ? { 'lorekit.scope': params.scope } : {}),
  });

  // Parse the caller's active filters — same names/shapes as GET /memories and
  // /facets — so the RPC narrows the written/scopes counts to the list's set.
  // Empty → null = "not filtered". `origin_pr` is digits-only (a non-numeric
  // entry narrows the filter, never 400s the page), matching the facets handler.
  const list = (v?: string) => { const a = parseTagsParam(v); return a.length ? a : null; };
  const prList = (() => {
    const a = parseTagsParam(params.origin_pr).filter((v) => /^\d+$/.test(v));
    return a.length ? a : null;
  })();

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<ActivityRow>('lorekit_memory_activity', {
    p_user_id: auth.userId ?? null,
    p_bucket: params.bucket,
    p_since: since,
    p_until: until,
    p_scope: params.scope ?? null,
    p_tags: list(params.tags),
    p_tags_mode: params.tags_mode,
    p_source_agent: list(params.source_agent),
    p_source_agent_mode: params.source_agent_mode,
    p_trigger: list(params.trigger),
    p_trigger_mode: params.trigger_mode,
    p_kind: list(params.kind),
    p_kind_mode: params.kind_mode,
    p_host: list(params.host),
    p_host_mode: params.host_mode,
    p_origin_repo: list(params.origin_repo),
    p_origin_repo_mode: params.origin_repo_mode,
    p_origin_branch: list(params.origin_branch),
    p_origin_branch_mode: params.origin_branch_mode,
    p_origin_pr: prList,
    p_origin_pr_mode: params.origin_pr_mode,
    // Owner (00063): `personal` plus org slugs; the RPC resolves the slugs
    // against the caller's member orgs, so the header narrows with the list.
    p_owner: list(params.owner),
    p_owner_mode: params.owner_mode,
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const buckets = ((data ?? []) as ActivityRow[]).map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    scope: r.scope,
    count: Number(r.count),
  }));
  span.setAttributes({ 'lorekit.result_count': buckets.length });
  return ok({ bucket: params.bucket, since, until, buckets }, cors);
}
