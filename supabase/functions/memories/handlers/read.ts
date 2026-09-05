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
import { CLIENT_HEADER } from '../../_shared/api/router.ts';
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

  span.setAttributes({ 'lorekit.result_count': rows.length });
  const res = ok(
    {
      entries: rows.map((r) => shapeMemoryRow(r as Record<string, unknown>)),
      missing: missingRefs(parsed, rows as { scope: string; key: string }[]),
    },
    cors,
  );
  res.headers.set('X-LoreKit-Result-Count', String(rows.length));
  // D6: however many refs resolve, this is ONE 'targeted' batch — never
  // 'bulk' — matching MCP's toolReadRefs (an agent naming exact lessons it
  // wants, the same intent memory.read's singular path already counts as
  // targeted).
  if (rows.length > 0) {
    recordMemoryReads(db, rows.map((r) => r.id), 'targeted', parseUsageClient(req.headers.get(CLIENT_HEADER)));
  }
  return res;
}
