import { createClient } from 'npm:@supabase/supabase-js@2';
import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import { ListMemoriesQuerySchema } from '@lorekit/schemas/memory';
import type { DbClient } from '../../_shared/api/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

async function getMemberOrgIds(db: DbClient, userId: string, span: Span): Promise<string[]> {
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb.rpc('lorekit_member_org_ids', { p_user_id: userId });
  if (error) { span.setAttributes({ 'auth.org_ids_error': error.message }); return []; }
  return (data ?? []) as string[];
}

export async function handleList(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ListMemoriesQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const q = validated.data;

  span.setAttributes({
    'lorekit.operation': 'memories.list',
    ...(q.scope ? { 'lorekit.scope': q.scope } : {}),
    ...(q.key ? { 'lorekit.key': q.key } : {}),
    'lorekit.limit': q.limit,
    'lorekit.archived': q.archived,
  });

  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const isArchived = q.archived === 'true';

  // deno-lint-ignore no-explicit-any
  let query: any = tracedDb
    .from('memories')
    .select('id,scope,key,value,tags,source_agent,trigger,created_at,updated_at,expires_at,archived_at')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(q.limit + 1);

  if (isArchived) query = query.not('archived_at', 'is', null);
  else query = query.is('archived_at', null).or('expires_at.is.null,expires_at.gt.now()');

  if (q.scope) query = query.eq('scope', q.scope);
  if (q.key) query = query.eq('key', q.key);

  if (q.tags) {
    const tags = q.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
    if (tags.length) query = query.overlaps('tags', tags);
  }

  if (auth.type !== 'service' && auth.userId) {
    const orgIdsSpan = span.child('lorekit.rest.auth.org_ids');
    const orgIds = await getMemberOrgIds(db, auth.userId, orgIdsSpan);
    orgIdsSpan.setAttributes({ 'lorekit.org_count': orgIds.length }).end();

    if (orgIds.length === 0) {
      query = query.eq('user_id', auth.userId);
    } else {
      const quoted = orgIds.map((id: string) => `"${id}"`).join(',');
      query = query.or(`user_id.eq.${auth.userId},org_id.in.(${quoted})`);
    }
  }

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (c) {
      query = query.or(`updated_at.lt.${c.updated_at},and(updated_at.eq.${c.updated_at},id.lt.${c.id})`);
    }
  }

  const { data, error } = await query;
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const page = buildPage((data ?? []) as Array<{ id: string; updated_at: string } & Record<string, unknown>>, q.limit);
  span.setAttributes({ 'lorekit.result_count': page.entries.length, 'lorekit.has_more': page.hasMore });
  return ok(page, cors);
}
