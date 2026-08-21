import type { AuthContext } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { firstDeniedScope } from '../../_shared/api/tenant.ts';
import { badRequest, forbidden, ok } from '../../_shared/api/respond.ts';
import { validateOptionalBody, validateQuery } from '../../_shared/api/validate.ts';
import { parseScopeFilter } from '../../_shared/scope.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/database.types.ts';
import { ActivityBodySchema, ActivityQuerySchema } from '../../_shared/schemas/memory.ts';
import { dimensionsFromBody, dimensionsFromQuery } from '../../_shared/schemas/dimensions.ts';
import type { MemoryDimensions } from '../../_shared/schemas/dimensions.ts';

type ActivityRow = Database['public']['Functions']['lorekit_memory_activity']['Returns'][number];

/** An activity request, decoded from either transport — see `list.ts`. */
interface ActivityInput {
  bucket: 'hour' | 'day';
  since?: string | undefined;
  until?: string | undefined;
  scope?: string | undefined;
  dimensions: MemoryDimensions;
}

/**
 * How far back a bare call looks. Long enough to cover the dashboard's widest
 * chart (30 daily buckets plus the 30 preceding it, for the period-over-period
 * comparison), with headroom.
 *
 * The window is bounded by default on purpose: an unbounded aggregate over
 * `memories` grows with account age, and no caller today wants "all time".
 *
 * **A caller whose chart is wider than this must pass `since` explicitly** —
 * the default cannot grow to fit every future chart, and a chart that outruns
 * it renders its uncovered days as EMPTY rather than as absent, which reads as
 * "nothing was written". The contribution heatmap does exactly that now that
 * its desktop span is a year (`lib/heatmap-window.ts` in `@lorekit/web`); this
 * default was originally sized for that heatmap back when it was a fixed 26
 * weeks, which is how the two drifted.
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
async function runActivity(
  input: ActivityInput,
  auth: AuthContext,
  db: DbClient,
  span: Span,
  cors: Record<string, string>,
): Promise<Response> {
  const { bucket, dimensions: d } = input;

  // Name the operation BEFORE the first early return, so a rejected request is
  // still attributable — a 400 returning above this would carry no
  // `lorekit.operation` and be invisible to the per-operation metrics.
  span.setAttributes({
    'lorekit.operation': 'memories.activity',
    'lorekit.bucket': bucket,
  });

  // Same GRAMMAR contract as the sibling `GET /memories/read-activity`: the
  // query schema is shape-only and the canonical grammar runs here so a
  // rejection can become a 400. The two endpoints answer the same question
  // about opposite verbs and take one set of parameters, so the same
  // ungrammatical input must be rejected by both rather than 400ing on one and
  // coming back as a silently-empty series from the other.
  //
  // CASE handling is where they diverge, and that is not an oversight: each
  // filter matches how its OWN table stores the value. This one filters
  // `memories.scope`, which the REST write path stores verbatim, so the filter
  // is reject-only. `read-activity` filters `usage_events.scope`, which is
  // written through the normalising `safeValidateScope` at the recording site
  // (`_shared/api/router.ts`), so it filters on `validateScope`'s lowercased
  // value. Lowercasing here — or keeping the caller's case there — would make
  // legitimately-stored rows unmatchable on one side or the other.
  //
  // It runs on the decoded input rather than in either entry point, so the
  // query and body transports cannot diverge on which scopes they accept.
  let scopeFilter: string | undefined;
  try {
    scopeFilter = parseScopeFilter(input.scope);
  } catch (e) {
    return badRequest((e as Error).message, undefined, cors);
  }

  const until = input.until ?? new Date().toISOString();
  const since = input.since ?? new Date(Date.parse(until) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();

  if (scopeFilter) span.setAttributes({ 'lorekit.scope': scopeFilter });

  // Early refusal for a NAMED scope outside the key's allowlist (00068/00069).
  // Without it `p_key_scopes` narrows the series to empty inside the RPC,
  // which reads as "there was no activity" rather than "you may not ask".
  //
  // It runs AFTER the grammar check, as it does in `list.ts` and `facets.ts` —
  // the refusal order is one contract across the scope-filtering routes.
  const deniedScope = firstDeniedScope(auth, [scopeFilter]);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  // Empty → null = "not filtered", which is what the RPC's parameters mean.
  const list = (values: readonly string[]) => (values.length ? [...values] : null);

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<ActivityRow>('lorekit_memory_activity', {
    p_user_id: auth.userId ?? null,
    p_bucket: bucket,
    p_since: since,
    p_until: until,
    p_scope: scopeFilter ?? null,
    p_tags: list(d.tags.values),
    p_tags_mode: d.tags.mode,
    p_source_agent: list(d.source_agent.values),
    p_source_agent_mode: d.source_agent.mode,
    p_trigger: list(d.trigger.values),
    p_trigger_mode: d.trigger.mode,
    p_kind: list(d.kind.values),
    p_kind_mode: d.kind.mode,
    p_host: list(d.host.values),
    p_host_mode: d.host.mode,
    p_origin_repo: list(d.origin_repo.values),
    p_origin_repo_mode: d.origin_repo.mode,
    p_origin_branch: list(d.origin_branch.values),
    p_origin_branch_mode: d.origin_branch.mode,
    p_origin_pr: list(d.origin_pr.values),
    p_origin_pr_mode: d.origin_pr.mode,
    // Owner (00064): `personal` plus org slugs; the RPC resolves the slugs
    // against the caller's member orgs, so the header narrows with the list.
    p_owner: list(d.owner.values),
    p_owner_mode: d.owner.mode,
    // The calling key's restriction (00068/00069). This series returns one row per
    // scope NAME, and a scope string IS a repo or project name, so an ungated
    // key could enumerate every repo through the chart. The rows are
    // aggregates, so post-filtering out here is not available.
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
    p_key_org_access: keyRestriction(auth)?.orgAccess ?? 'all',
    p_key_org_ids: keyRestriction(auth)?.orgIds ?? [],
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const buckets = ((data ?? []) as ActivityRow[]).map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    scope: r.scope,
    count: Number(r.count),
  }));
  span.setAttributes({ 'lorekit.result_count': buckets.length });
  return ok({ bucket, since, until, buckets }, cors);
}

/** `GET /memories/activity` — the query-string form. */
export async function handleActivity(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ActivityQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const p = validated.data;

  return runActivity({
    bucket: p.bucket,
    since: p.since,
    until: p.until,
    scope: p.scope,
    dimensions: dimensionsFromQuery(p),
  }, auth, db, span, cors);
}

/**
 * `POST /memories/activity` — the same series, over a JSON body.
 *
 * The Explorer's stat header passes the identical filter bar the list does, so
 * it meets the query string's per-dimension cap at the same width. Fixing the
 * list without this would leave the header 400ing above the rows it describes.
 */
export async function handleActivityPost(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = await validateOptionalBody(req, ActivityBodySchema, cors);
  if (!validated.ok) return validated.response;
  const b = validated.data;

  return runActivity({
    bucket: b.bucket,
    since: b.since,
    until: b.until,
    scope: b.scope,
    dimensions: dimensionsFromBody(b),
  }, auth, db, span, cors);
}
