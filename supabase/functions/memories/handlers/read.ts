import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { TracedQuery, Span } from '../../_shared/telemetry/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/db/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope } from '../../_shared/api/tenant.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { MEMORY_SELECT, shapeMemoryRow, ReadMemoriesBodySchema } from '../../_shared/schemas/memory.ts';
import { parseMemoryRefs } from '../../_shared/scope/scope.ts';
import { groupRefsByScope, missingRefs, unbatchableRefs } from '../../_shared/memory/read-refs.ts';
import { recordMemoryReads } from '../../_shared/telemetry/memory-reads.ts';
import {
  CLIENT_HEADER,
  RESULT_COUNT_HEADER,
  RESOLVED_SCOPE_HEADER,
  SCOPE_COUNT_HEADER,
  SCOPE_TYPE_HEADER,
} from '../../_shared/api/router.ts';
import { scopeTypeAttribute } from '../../_shared/scope/scope-type-attribute.ts';
import { parseUsageClient } from '../../_shared/telemetry/usage-stats.ts';

type MemoryRow = Tables<'memories'>;

/**
 * `POST /memories/read` — batch read by `scope::key` reference (R1, R4, R6, R7,
 * R8). The REST counterpart to MCP's `toolReadRefs`. Modelled on `get.ts` for
 * everything below the fan-out: one `.eq('scope', s).in('key', keys)` query
 * per DISTINCT scope (plan D5), plus one `.eq('key', k)` for each key an
 * `.in()` list cannot carry, all awaited CONCURRENTLY, `memberOrgIds`
 * resolved ONCE ahead of the fan-out and reused by every query's tenant
 * predicate.
 *
 * Registered as a LITERAL route in `index.ts`, ahead of `/:id` — see the
 * "ROUTE ORDER MATTERS" comment there.
 */
export async function handleRead(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = await validateBody(req, ReadMemoriesBodySchema, cors);
  if (!v.ok) return v.response;

  const parsed = parseMemoryRefs(v.data.refs);
  // Both counts, because `parseMemoryRefs` TRUNCATES at `MEMORY_CITED_MAX` and
  // drops unparseable refs silently — neither loss appears in `missing`, so
  // `count` alone reports a 40-ref batch as a 32-ref one. The gap between the
  // two is the only place truncation is observable. Numeric measures, not
  // dimensions: no cardinality added.
  span.setAttributes({
    'lorekit.operation': 'memories.read_refs',
    'lorekit.refs.requested': v.data.refs.length,
    'lorekit.refs.count': parsed.length,
  });

  const groups = groupRefsByScope(parsed);
  const singles = unbatchableRefs(parsed);
  const tracedDb = createTracedClient(db, span);

  const orgIds = auth.type === 'api_key' && auth.userId ? await getMemberOrgIds(db, auth.userId, span) : [];

  // One query builder for both key shapes, so the batched and single-key paths
  // cannot drift in their tenant, archived or expiry predicates.
  const run = async (scope: string, keyFilter: { in: string[] } | { eq: string }) => {
    const base = tracedDb.from('memories').select(MEMORY_SELECT).eq('scope', scope);
    let query: TracedQuery<MemoryRow> = ('in' in keyFilter ? base.in('key', keyFilter.in) : base.eq('key', keyFilter.eq))
      .is('archived_at', null)
      .or('expires_at.is.null,expires_at.gt.now()');
    if (auth.type === 'api_key' && auth.userId) {
      query = applyRestTenantScope(query, auth.userId, orgIds, keyRestriction(auth));
    }
    const { data, error } = await query;
    if (error) { span.error(`DB: ${error.message}`); throw error; }
    return (data ?? []) as MemoryRow[];
  };

  const rows = (
    await Promise.all([
      ...groups.map(({ scope, keys }) => run(scope, { in: keys })),
      // A key carrying `,()"\` is legal in the table but not in an `.in()` list,
      // so it gets the singular read's own `.eq` rather than being dropped into
      // `missing`, which would report an existing lesson as not found.
      ...singles.map(({ scope, key }) => run(scope, { eq: key })),
    ])
  ).flat();

  // `lorekit.result.count` — the DOTTED spelling every other handler and MCP's
  // own batch path use (`list.ts`, `search.ts`, `archive.ts`, `toolReadRefs`),
  // and the one `docs/otel.md` documents. This read shipped `result_count`,
  // which is a different attribute key: a dashboard panel or alert querying the
  // documented name reports NOTHING for batch reads rather than reporting zero.
  //
  // `missing` computed ONCE into a local and used for both the attribute and the
  // body, so the number the telemetry reports can never describe a different set
  // from the one the caller received. Its complement is the useful signal: a
  // batch whose refs mostly miss is an agent working from a stale ref list, and
  // it is invisible in `result.count` alone (a 20-ref batch returning 3 rows and
  // a 3-ref batch returning 3 rows are the same number).
  const missing = missingRefs(parsed, rows as { scope: string; key: string }[]);
  span.setAttributes({
    'lorekit.result.count': rows.length,
    'lorekit.refs.missing': missing.length,
  });
  const res = ok(
    {
      entries: rows.map((r) => shapeMemoryRow(r as Record<string, unknown>)),
      missing,
    },
    cors,
  );
  res.headers.set(RESULT_COUNT_HEADER, String(rows.length));
  // Scope attribution for the router's usage event and the `lorekit.scope.type`
  // span attribute — the router never consumes the body, so without these three
  // headers a batch read records NO scope on any dimension: `usage_events`'
  // `scope_type`/`scope`/`scope_count` all null, and the `lorekit.tool.duration`
  // histogram putting every batch read in the unlabelled bucket of its one
  // dimension. `search.ts` sets the first two for exactly this reason.
  //
  // Counted over DISTINCT scopes, not refs: many refs routinely name one scope,
  // so the only count that means anything is how many scopes the batch touched —
  // the same unit `groupRefsByScope` already turns the batch into queries by.
  // Derived from `parsed`, so a truncated or unparseable tail is attributed to
  // nothing rather than to the scopes that survived.
  const scopes = [...new Set(parsed.map((r) => r.scope))];
  if (scopes.length > 0) {
    res.headers.set(SCOPE_COUNT_HEADER, String(scopes.length));
    // The single resolved scope only when the batch named exactly one. A batch
    // spanning several — the shape this feature exists for — has no single
    // scope, which is why the TYPE header is separate rather than derived from
    // this one: `mixed` is precisely the answer this header cannot give.
    if (scopes.length === 1) res.headers.set(RESOLVED_SCOPE_HEADER, scopes[0]);
    // Produced with the SAME shared resolver the router uses on the
    // query-string path, and re-validated against the closed vocabulary by that
    // module's own `parseScopeTypeAttribute` on the router side — the dimension
    // stays bounded by a check on the reading side, never by trust in this
    // writer.
    const scopeType = scopeTypeAttribute(undefined, scopes);
    if (scopeType) res.headers.set(SCOPE_TYPE_HEADER, scopeType);
  }
  // D6: however many refs resolve, this is ONE 'targeted' batch — never
  // 'bulk' — matching MCP's toolReadRefs (an agent naming exact lessons it
  // wants, the same intent memory.read's singular path already counts as
  // targeted).
  if (rows.length > 0) {
    recordMemoryReads(db, rows.map((r) => r.id), 'targeted', parseUsageClient(req.headers.get(CLIENT_HEADER)));
  }
  return res;
}
