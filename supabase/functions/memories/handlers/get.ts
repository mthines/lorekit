import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, notFound } from '../../_shared/api/respond.ts';
import { validateUuid } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { TracedQuery, Span } from '../../_shared/telemetry/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/db/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope, restSupersededBy } from '../../_shared/api/tenant.ts';
import { withSupersededBy } from '../../_shared/provenance/record-extensions.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
import { recordMemoryReads } from '../../_shared/telemetry/memory-reads.ts';
import { CLIENT_HEADER } from '../../_shared/api/router.ts';
import { parseUsageClient } from '../../_shared/telemetry/usage-stats.ts';
import { NOT_EXPIRED } from '../../_shared/memory/live.ts';

type MemoryRow = Tables<'memories'>;

export async function handleGet(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = validateUuid(params.id ?? '', cors);
  if (!v.ok) return v.response;

  span.setAttributes({ 'lorekit.operation': 'memories.get', 'lorekit.memory_id': v.data });

  const tracedDb = createTracedClient(db, span);
  let q: TracedQuery<MemoryRow> = tracedDb
    .from('memories')
    .select(MEMORY_SELECT)
    .eq('id', v.data)
    .is('archived_at', null)
    .or(NOT_EXPIRED);

  // api_key auth uses service-role client (bypasses RLS) — apply tenant filter.
  // JWT auth uses RLS-scoped client — RLS handles visibility automatically.
  const orgIds = auth.type === 'api_key' && auth.userId ? await getMemberOrgIds(db, auth.userId, span) : undefined;
  if (auth.type === 'api_key' && auth.userId && orgIds) {
    q = applyRestTenantScope(q, auth.userId, orgIds, keyRestriction(auth));
  }

  const { data, error } = await q.maybeSingle();
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  if (!data) return notFound('Memory', cors);
  // One record read — surfaced for the router's usage event (RESULT_COUNT_HEADER).
  // `superseded_by` (00120), under the same visibility as this read.
  const links = await restSupersededBy(db, auth, span, [(data as { id: string }).id], orgIds);
  const res = ok(withSupersededBy(shapeMemoryRow(data as Record<string, unknown>), links), cors);
  res.headers.set('X-LoreKit-Result-Count', '1');
  // GET /:id is the REST equivalent of memory.read — one exact scope+key —
  // so it is a TARGETED read for the per-memory counter (migration 00077).
  // This route is shared by the web dashboard's detail sheet AND the CLI's
  // remote read/show command, so — unlike MCP's memory.read, which can
  // hardcode 'mcp' because the transport itself is the attribution — the
  // caller-supplied X-LoreKit-Client header decides whether this counts as an
  // agent opening the lesson (migration 00099's last_opened_at) or a human
  // browsing the dashboard.
  recordMemoryReads(db, [(data as { id: string }).id], 'targeted', parseUsageClient(req.headers.get(CLIENT_HEADER)));
  return res;
}
