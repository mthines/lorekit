import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { notFound, ok } from '../../_shared/api/respond.ts';
import { applyRestTenantScope, getMemberOrgIds } from '../../_shared/api/tenant.ts';
import { validateQuery, validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span, TracedQuery } from '../../_shared/telemetry/otel.ts';
import type { Tables } from '../../_shared/db/database.types.ts';
import { NeighboursQuerySchema } from '../../_shared/schemas/memory.ts';
import type { MemoryEdgeKind } from '../../_shared/schemas/memory.ts';
import { clusterDuplicatesBlocked } from '../../_shared/clusters/duplicate-clusters.ts';
import { NOT_EXPIRED } from '../../_shared/memory/live.ts';

type MemoryRow = Tables<'memories'>;

/** The raw shape `lorekit_memory_neighbours` returns (migration 00122). */
interface RawNeighbourRow {
  kind: 'co_cited' | 'cited_by' | 'cites' | 'supersedes' | 'superseded_by' | 'run';
  memory_id: string | null;
  scope: string | null;
  key: string | null;
  weight: number;
  last_at: string | null;
  correlation_id: string | null;
  session_kind: string | null;
}

/**
 * Near-duplicate similarity that makes a `duplicate` edge. Same default
 * `GET /memories/clusters` and `lorekit dedupe` use, so the drawer and the
 * Duplicate Clusters panel never disagree about what is a duplicate.
 */
const DUPLICATE_THRESHOLD = 0.8;

/** Same cap and reasoning as `clusters.ts` — bodies are fetched to be tokenized. */
const DUPLICATE_CANDIDATE_LIMIT = 150;

/**
 * `GET /memories/:id/neighbours` — one lesson's connections.
 *
 * Co-cited / cited-by / cites / supersedes / superseded-by and the runs the
 * lesson was credited in come from `lorekit_memory_neighbours` (00122). The
 * near-duplicate edges are computed here, in TypeScript, by the SAME shared
 * core `GET /memories/clusters` uses — never a SQL copy that could disagree.
 *
 * REST-only by decision (`memory.neighbours` in `telemetry-vocabulary.ts`).
 * The focus lesson is fetched under the caller's tenancy first, so an id the
 * caller cannot see is a 404 exactly like `GET /:id`, and nothing about
 * someone else's lore is reachable through its connections.
 */
export async function handleNeighbours(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = validateUuid(params.id ?? '', cors);
  if (!v.ok) return v.response;
  const validated = validateQuery(req, NeighboursQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const { limit } = validated.data;

  span.setAttributes({
    'lorekit.operation': 'memories.neighbours',
    'lorekit.memory_id': v.data,
    'lorekit.limit': limit,
  });

  const tracedDb = createTracedClient(db, span);
  const orgIds = auth.type === 'api_key' && auth.userId ? await getMemberOrgIds(db, auth.userId, span) : undefined;

  let focusQ: TracedQuery<MemoryRow> = tracedDb
    .from('memories')
    .select('id,scope,key,value')
    .eq('id', v.data)
    .is('archived_at', null)
    .or(NOT_EXPIRED);
  if (auth.type === 'api_key' && auth.userId && orgIds) {
    focusQ = applyRestTenantScope(focusQ, auth.userId, orgIds, keyRestriction(auth));
  }
  const { data: focus, error: focusError } = await focusQ.maybeSingle();
  if (focusError) { span.error(`DB: ${focusError.message}`); throw focusError; }
  if (!focus) return notFound('Memory', cors);
  const focusRow = focus as Pick<MemoryRow, 'id' | 'scope' | 'key' | 'value'>;

  const { data, error } = await tracedDb.rpc<RawNeighbourRow>('lorekit_memory_neighbours', {
    p_user_id: auth.userId ?? null,
    p_memory_id: v.data,
    p_limit: limit,
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const rows = (data ?? []) as RawNeighbourRow[];
  const neighbours: {
    kind: MemoryEdgeKind; id: string; scope: string; key: string; weight: number; last_at: string | null;
  }[] = [];
  const runs: { correlation_id: string; session_kind: string | null; last_at: string | null; cited_count: number }[] = [];
  for (const r of rows) {
    if (r.kind === 'run') {
      if (r.correlation_id) {
        runs.push({
          correlation_id: r.correlation_id,
          session_kind: r.session_kind,
          last_at: r.last_at,
          cited_count: r.weight,
        });
      }
    } else if (r.memory_id && r.scope !== null && r.key !== null) {
      neighbours.push({
        kind: r.kind, id: r.memory_id, scope: r.scope, key: r.key, weight: r.weight, last_at: r.last_at,
      });
    }
  }

  // Near-duplicates: this lesson's own scope window, clustered by the shared core.
  let dupQ: TracedQuery<MemoryRow> = tracedDb
    .from('memories')
    .select('id,scope,key,value,updated_at')
    .eq('scope', focusRow.scope)
    .is('archived_at', null)
    .or(NOT_EXPIRED)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(DUPLICATE_CANDIDATE_LIMIT);
  if (auth.type === 'api_key' && auth.userId && orgIds) {
    dupQ = applyRestTenantScope(dupQ, auth.userId, orgIds, keyRestriction(auth));
  }
  const { data: dupData, error: dupError } = await dupQ;
  if (dupError) { span.error(`DB: ${dupError.message}`); throw dupError; }

  const candidates = ((dupData ?? []) as Pick<MemoryRow, 'id' | 'scope' | 'key' | 'value' | 'updated_at'>[]);
  // The focus lesson must be in the window or no cluster can contain it.
  if (!candidates.some((c) => c.id === focusRow.id)) candidates.push({ ...focusRow, updated_at: '' });
  const clusters = clusterDuplicatesBlocked(
    candidates.map((c) => ({
      id: c.id, scope: c.scope, key: c.key, value: c.value, updatedAt: c.updated_at || null,
    })),
    DUPLICATE_THRESHOLD,
  );
  const mine = clusters.find((cl) => cl.members.some((m) => m.id === focusRow.id));
  if (mine) {
    const sim = Math.round(mine.minSimilarity * 100);
    for (const m of mine.members) {
      if (m.id === focusRow.id) continue;
      neighbours.push({ kind: 'duplicate', id: m.id, scope: m.scope, key: m.key, weight: sim, last_at: m.updatedAt ?? null });
    }
  }

  span.setAttributes({ 'lorekit.result_count': neighbours.length, 'lorekit.run_count': runs.length });
  const res = ok({ id: focusRow.id, neighbours, runs }, cors);
  res.headers.set('X-LoreKit-Result-Count', String(neighbours.length));
  return res;
}
