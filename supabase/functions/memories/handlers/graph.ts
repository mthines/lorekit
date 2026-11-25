import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { badRequest, forbidden, ok } from '../../_shared/api/respond.ts';
import { firstDeniedScope } from '../../_shared/api/tenant.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { parseScopeFilter } from '../../_shared/scope/scope.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import { MemoryGraphQuerySchema } from '../../_shared/schemas/memory.ts';
import type { MemoryGraphResponse } from '../../_shared/schemas/memory.ts';

/**
 * `GET /memories/graph` — the corpus co-usage graph.
 *
 * Lessons credited in the same run are joined by an edge weighted by the number
 * of distinct runs they shared; read-but-never-used lessons ride along as
 * orphans. All of it comes from `lorekit_memory_graph` (00122) — the pair
 * self-join belongs next to the `memory_citations` index it runs on.
 *
 * REST-only by decision (`memory.graph` in `telemetry-vocabulary.ts`): a node is
 * a scope + key, the same name-bearing surface as `/tags` and `/facets`.
 */
export async function handleGraph(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, MemoryGraphQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  // Fail LOUD on a scope filter, and `parseScopeFilter` (verbatim, no
  // lowercasing) because it filters `memories.scope` — see clusters.ts.
  let scopeFilter: string | undefined;
  try {
    scopeFilter = parseScopeFilter(params.scope);
  } catch (e) {
    return badRequest((e as Error).message, undefined, cors);
  }

  const deniedScope = firstDeniedScope(auth, [scopeFilter ?? null]);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  span.setAttributes({
    'lorekit.operation': 'memories.graph',
    'lorekit.limit': params.limit_nodes,
    ...(scopeFilter ? { 'lorekit.scope': scopeFilter } : {}),
  });

  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.rpc<MemoryGraphResponse>('lorekit_memory_graph', {
    p_user_id: auth.userId ?? null,
    p_scope: scopeFilter ?? null,
    p_min_weight: params.min_weight,
    p_limit_nodes: params.limit_nodes,
    p_since: params.since ?? null,
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  // A jsonb-returning RPC comes back as the object itself (PostgREST), but a
  // wrapper may hand it as a one-element array — accept both.
  const raw = (Array.isArray(data) ? data[0] : data) as MemoryGraphResponse | null;
  const graph: MemoryGraphResponse = {
    nodes: raw?.nodes ?? [],
    edges: raw?.edges ?? [],
    truncated: raw?.truncated ?? false,
    // A database still on 00122 has no total: the listed orphans are all it can say.
    orphan_total: raw?.orphan_total ?? (raw?.nodes ?? []).filter((n) => n.orphan).length,
  };
  span.setAttributes({ 'lorekit.result_count': graph.nodes.length, 'lorekit.edge_count': graph.edges.length });
  const res = ok(graph, cors);
  res.headers.set('X-LoreKit-Result-Count', String(graph.nodes.length));
  return res;
}
