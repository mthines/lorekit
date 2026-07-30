import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { TracedQuery, Span } from '../../_shared/otel.ts';
import { ListMemoriesQuerySchema } from '@lorekit/schemas/memory';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/database.types.ts';

type MemoryRow = Tables<'memories'>;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function getMemberOrgIds(db: DbClient, userId: string, span: Span): Promise<string[]> {
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb.rpc<string>('lorekit_member_org_ids', { p_user_id: userId });
  if (error) { span.setAttributes({ 'auth.org_ids_error': error.message }); return []; }
  return (data ?? []) as string[];
}

export async function handleList(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ListMemoriesQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const params = validated.data;

  span.setAttributes({
    'lorekit.operation': 'memories.list',
    ...(params.scope ? { 'lorekit.scope': params.scope } : {}),
    ...(params.key ? { 'lorekit.key': params.key } : {}),
    'lorekit.limit': params.limit,
    'lorekit.archived': params.archived,
  });

  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const isArchived = params.archived === 'true';

  let q: TracedQuery<MemoryRow> = tracedDb
    .from<MemoryRow>('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(params.limit + 1);

  if (isArchived) q = q.not('archived_at', 'is', null);
  else q = q.is('archived_at', null).or('expires_at.is.null,expires_at.gt.now()');

  if (params.scope) q = q.eq('scope', params.scope);
  if (params.key) q = q.eq('key', params.key);

  if (params.tags) {
    const tags = params.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
    if (tags.length) q = q.overlaps('tags', tags);
  }

  if (auth.type !== 'service' && auth.userId) {
    const orgIdsSpan = span.child('lorekit.rest.auth.org_ids');
    const orgIds = await getMemberOrgIds(db, auth.userId, orgIdsSpan);
    orgIdsSpan.setAttributes({ 'lorekit.org_count': orgIds.length }).end();

    if (orgIds.length === 0) {
      q = q.eq('user_id', auth.userId);
    } else {
      const quoted = orgIds.map((id: string) => `"${id}"`).join(',');
      q = q.or(`user_id.eq.${auth.userId},org_id.in.(${quoted})`);
    }
  }

  if (params.cursor) {
    const c = decodeCursor(params.cursor);
    if (c) {
      q = q.or(`updated_at.lt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.lt.${c.id})`);
    }
  }

  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const page = buildPage(data ?? [], params.limit);
  span.setAttributes({ 'lorekit.result_count': page.entries.length, 'lorekit.has_more': page.hasMore });
  return ok(page, cors);
}
