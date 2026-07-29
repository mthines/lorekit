/**
 * POST /rest-memories/search
 *
 * Full-text search and/or scope/tag filtering with cursor-based pagination.
 * More powerful than the GET /rest-memories query params — supports full-text
 * search via Postgres FTS and multi-scope filtering.
 *
 * Request body: MemorySearchBodySchema
 *   q?      — full-text search query (websearch syntax)
 *   scopes? — scope filter list (exact or wildcard repo::owner/*)
 *   tags?   — tag filter (any match)
 *   limit?  — max items (1–100, default 20)
 *   cursor? — opaque pagination cursor
 *
 * Response: { entries: Memory[], nextCursor: string | null, hasMore: boolean }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthContext, getUserId } from '../../_shared/api/auth.ts';
import { ok, fromError } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { MemorySearchBodySchema } from '../../_shared/schemas/memory.ts';
import { createTracedClient, type Span } from '../../_shared/otel.ts';
import { applyTenantScope } from '../../_shared/tenant-scope.ts';
import { expandScopeForSearch } from '../../_shared/scope.ts';

async function memberOrgIds(db: ReturnType<typeof createClient>, userId: string): Promise<string[]> {
  const { data, error } = await db.rpc('lorekit_member_org_ids', { p_user_id: userId });
  return error ? [] : ((data ?? []) as string[]);
}

export async function handleSearch(
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  _params: Record<string, string>,
): Promise<Response> {
  const parsed = await validateBody(req, MemorySearchBodySchema);
  if (!parsed.ok) return parsed.error;
  const p = parsed.data;

  span.setAttributes({
    'lorekit.rest.action': 'search',
    ...(p.q ? { 'lorekit.search.query': p.q } : {}),
    'lorekit.rest.limit': p.limit,
  });

  try {
    const userId = getUserId(auth);
    const tracedDb = createTracedClient(db, span);
    const cursor = decodeCursor(p.cursor);

    const SELECT =
      'id,scope,key,value,tags,source_agent,trigger,org_id,created_at,updated_at,expires_at,archived_at';

    let query = tracedDb
      .from('memories')
      .select(SELECT)
      .is('archived_at', null)
      .or('expires_at.is.null,expires_at.gt.now()')
      .limit(p.limit + 1);

    // Full-text search
    if (p.q) {
      query = query.textSearch('fts', p.q, { type: 'websearch', config: 'english' });
      // When using FTS, order by relevance rank (no keyset — FTS doesn't support it cleanly)
      query = query.order('updated_at', { ascending: false });
    } else {
      query = query.order('updated_at', { ascending: false }).order('id', { ascending: false });
    }

    // Tag filter
    if (p.tags?.length) query = query.overlaps('tags', p.tags);

    // Scope filter
    if (p.scopes?.length) {
      const exactScopes: string[] = [];
      const likePatterns: string[] = [];
      for (const s of p.scopes) {
        const filter = expandScopeForSearch(s);
        if ('exact' in filter) exactScopes.push(filter.exact);
        else likePatterns.push(filter.like);
      }
      const orParts: string[] = [];
      if (exactScopes.length > 0) {
        orParts.push(`scope.in.(${exactScopes.map((s) => `"${s}"`).join(',')})`);
      }
      for (const pat of likePatterns) {
        orParts.push(`scope.like.${pat}`);
      }
      if (orParts.length > 0) query = query.or(orParts.join(','));
    }

    // Apply tenant scope
    if (userId) {
      const orgIds = await memberOrgIds(db, userId);
      query = applyTenantScope(query, userId, orgIds);
    }

    // Cursor (only useful when not using FTS ordering)
    if (cursor && !p.q) {
      query = query.or(
        `updated_at.lt.${cursor.t},and(updated_at.eq.${cursor.t},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) {
      span.error(`SearchError: ${error.message}`);
      return fromError(error, 'search');
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const page = buildPage(rows, p.limit, (row) => ({
      t: row['updated_at'] as string,
      id: row['id'] as string,
    }));

    span.setAttributes({ 'lorekit.result.count': page.entries.length });
    return ok(page);
  } catch (err) {
    return fromError(err, 'search');
  }
}
