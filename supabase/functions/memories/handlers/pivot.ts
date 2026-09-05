import type { AuthContext } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { firstDeniedScope } from '../../_shared/api/tenant.ts';
import { badRequest, forbidden, ok } from '../../_shared/api/respond.ts';
import { validateBody, validateQuery } from '../../_shared/api/validate.ts';
import { parseScopeFilter } from '../../_shared/scope/scope.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import {
  PIVOT_LIMIT_DEFAULT,
  PivotBodySchema,
  PivotQuerySchema,
} from '../../_shared/schemas/memory.ts';
import type { MemoryFacet } from '../../_shared/schemas/memory.ts';
import { dimensionsFromBody, dimensionsFromQuery } from '../../_shared/schemas/dimensions.ts';
import type { MemoryDimensions } from '../../_shared/schemas/dimensions.ts';
import { retentionFrom, retentionRpcParams } from '../../_shared/api/retention.ts';
import type { RetentionConditions } from '../../_shared/api/retention.ts';
import type { DbClient } from '../../_shared/api/auth.ts';

/** One row as `lorekit_memory_pivot` returns it. */
interface PivotRow {
  row_value: string;
  col_value: string;
  count: number;
}

/** A pivot read, decoded from EITHER transport. */
interface PivotInput {
  row: MemoryFacet;
  col: MemoryFacet;
  archived: boolean;
  limit: number;
  scope?: string | undefined;
  dimensions: MemoryDimensions;
  /**
   * The `created_at` window and the five retention thresholds (00108) — the
   * same pair `/facets` takes, for the same reason: the matrix and the facet
   * menu are two views of one population and must narrow together.
   */
  created_since?: string | undefined;
  created_until?: string | undefined;
  retention: RetentionConditions;
}

/**
 * `GET|POST /memories/pivot` — how many memories carry each pair of values
 * across two dimensions.
 *
 * ## Why it is its own route rather than N calls to `/facets`
 *
 * `/facets` answers the one-dimensional question. The two-dimensional one could
 * be assembled client-side by re-asking `/facets` once per row value with that
 * value pushed into the filters — an N+1 whose N is chosen by a UI, over the
 * largest table in the schema, and one that would recompute the same base scan
 * N times. It is the aggregate-in-Postgres rule (`packages/web/CLAUDE.md`) for
 * the same reason `GET /scopes` exists instead of a `select` plus a client-side
 * `Set`.
 *
 * ## Both axes are self-excluded, and that IS the feature
 *
 * 00057 established that a facet is counted with every OTHER active filter
 * applied but not its own. A pivot has two dimensions in that position, so
 * `lorekit_memory_pivot` excludes both. Without it, a caller that turns a cell
 * into `row in [x] AND col in [y]` and asks again gets a grid where every other
 * cell reads zero — one click and the instrument is a dead end. With it, the
 * counts answer "what would selecting this cell yield", which is the question a
 * navigable grid has to answer.
 *
 * Tenant scoping, the calling key's restriction and the archived/expired
 * partition all live in the RPC, exactly as they do for `/facets`, `/tags` and
 * `/scopes` — so there is deliberately no `applyRestTenantScope` here: there is
 * no query to scope, and a second predicate would be somewhere for the two to
 * drift.
 *
 * Inherits `/facets`' two reading caveats verbatim: a pair counting zero emits
 * no cell, and `q` / `key` / the date window are not mirrored, so under a search
 * a count is an upper bound rather than the exact yield.
 */
async function runPivot(
  input: PivotInput,
  auth: AuthContext,
  db: DbClient,
  span: Span,
  cors: Record<string, string>,
): Promise<Response> {
  const { row, col, archived, limit, dimensions: d } = input;

  // Named BEFORE the first early return, so a rejected request is still
  // attributable — the same rule `runFacets` and `respondWithPage` follow.
  span.setAttributes({
    'lorekit.operation': 'memories.pivot',
    'lorekit.archived': String(archived),
    'lorekit.pivot.row': row,
    'lorekit.pivot.col': col,
    'lorekit.limit': limit,
  });

  // The Explorer sends its selected scope here as well as to `GET /memories`,
  // so the matrix drills down with the list. The two must agree on what a scope
  // IS: keeping an ungrammatical value here while the list rejects it would
  // have the grid answer a different question than the rows beside it.
  let scopeFilter: string | undefined;
  try {
    scopeFilter = parseScopeFilter(input.scope);
  } catch (e) {
    return badRequest((e as Error).message, undefined, cors);
  }

  // Early refusal for a NAMED scope outside the key's allowlist (00068/00069).
  // Without it `p_key_scopes` narrows the counts to empty inside the RPC, which
  // reads as "there is nothing there" rather than "you may not ask".
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
  const { data, error } = await tracedDb.rpc<PivotRow>('lorekit_memory_pivot', {
    p_row_facet: row,
    p_col_facet: col,
    p_user_id: auth.userId ?? null,
    p_archived: archived,
    p_scope: scopeFilter ?? null,
    // One over the cap, so a full page is distinguishable from a page that
    // happens to land exactly on it — `truncated` must not be a guess.
    p_limit: limit + 1,
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
    p_owner: list(d.owner.values),
    p_owner_mode: d.owner.mode,
    // The calling key's restriction (00068/00069). `origin_repo` is a repository
    // name by construction, so an unnarrowed pivot leaks exactly what the scope
    // catalog hides.
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
    p_key_org_access: keyRestriction(auth)?.orgAccess ?? 'all',
    p_key_org_ids: keyRestriction(auth)?.orgIds ?? [],
    // The `created_at` window and the retention thresholds (00108), so a cell
    // counts the same rows the list returns.
    p_created_since: input.created_since ?? null,
    p_created_until: input.created_until ?? null,
    ...retentionRpcParams(input.retention),
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const rows = (data ?? []) as PivotRow[];
  const truncated = rows.length > limit;
  const cells = rows.slice(0, limit).map((r) => ({
    row: r.row_value,
    col: r.col_value,
    count: Number(r.count),
  }));

  span.setAttributes({ 'lorekit.result_count': cells.length, 'lorekit.truncated': String(truncated) });
  return ok({ row, col, cells, truncated }, cors);
}

/** `GET /memories/pivot` — the query-string form. */
export async function handlePivot(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, PivotQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const q = validated.data;

  return runPivot({
    row: q.row,
    col: q.col,
    archived: q.archived === 'true',
    limit: q.limit ?? PIVOT_LIMIT_DEFAULT,
    scope: q.scope,
    dimensions: dimensionsFromQuery(q),
    created_since: q.created_since,
    created_until: q.created_until,
    retention: retentionFrom(q),
  }, auth, db, span, cors);
}

/**
 * `POST /memories/pivot` — the same cross-tabulation, over a JSON body.
 *
 * Exists for `POST /list`'s reason: the Explorer passes its whole filter bar so
 * the grid drills down, which means it meets the 2048-character-per-dimension
 * wall at exactly the width the list does.
 *
 * Both transports decode into `runPivot`, so neither can decide anything about
 * filtering the other does not — including which scopes are legal.
 */
export async function handlePivotPost(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = await validateBody(req, PivotBodySchema, cors);
  if (!validated.ok) return validated.response;
  const body = validated.data;

  return runPivot({
    row: body.row,
    col: body.col,
    archived: body.archived,
    limit: body.limit ?? PIVOT_LIMIT_DEFAULT,
    scope: body.scope,
    dimensions: dimensionsFromBody(body),
    created_since: body.created_since,
    created_until: body.created_until,
    retention: retentionFrom(body),
  }, auth, db, span, cors);
}
