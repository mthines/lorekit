import type { AuthContext } from '../../_shared/api/auth.ts';
import { created, tooManyRequests } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import { CreateMemoryBodySchema } from '@lorekit/schemas/memory';
import { translateDbError } from '../../_shared/api/errors.ts';
import { recordRestAudit } from '../../_shared/audit.ts';
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
    p_created_at: null,
    p_org_slug: body.org ?? null,
    p_ttl_days: body.ttl_days ?? null,
    p_clear_ttl: body.clear_ttl ?? false,
  });

  if (error) {
    const mapped = translateDbError(error);
    if (mapped) return mapped.toResponse(cors);
    span.error(`DB: ${error.message}`);
    throw error;
  }

  // Fetch the full row so the response matches MemoryEntrySchema.
  // `inserted` (migration 00011, `RETURNING (xmax = 0)`) is the create-vs-update
  // discriminator — an internal audit-classification signal, deliberately not
  // part of the response contract.
  const row = data as { id: string; created_at: string; inserted?: boolean; expires_at?: string | null } | null;
  if (!row?.id) {
    span.error('memory_write returned no id');
    throw new Error('memory_write returned no id');
  }
  const { data: entry, error: fetchErr } = await createTracedClient(db, span)
    .from('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .eq('id', row.id)
    .single();

  if (fetchErr) { span.error(`DB: ${fetchErr.message}`); throw fetchErr; }
  span.setAttributes({ 'lorekit.memory_id': row.id, 'lorekit.write.inserted': row.inserted !== false });

  // Audit AFTER the write has committed. `inserted !== false` (not
  // `inserted === true`) mirrors toolWrite exactly: an older `memory_write`
  // that predates the 00011 `inserted` column returns undefined, and the
  // upsert's create branch is the safer default to assume.
  await recordRestAudit(db, span, auth, {
    action: row.inserted === false ? 'memory.update' : 'memory.create',
    resourceType: 'memory',
    resourceId: row.id,
    target: body.key,
    metadata: { scope: body.scope, key: body.key, ...(body.org ? { org: body.org } : {}) },
  });

  return created(entry, cors);
}
