/**
 * GET /rest-memories
 *
 * Lists memories with optional filtering and cursor-based pagination.
 *
 * Query params (all optional):
 *   scope    — exact scope string (e.g. "global", "repo::owner/repo")
 *   key      — exact key; when combined with scope performs a natural key lookup
 *   tags     — tag filter (any match); repeatable or comma-separated
 *   limit    — max items per page (1–100, default 50)
 *   cursor   — opaque cursor from a previous response's nextCursor
 *
 * Response: { entries: Memory[], nextCursor: string | null, hasMore: boolean }
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { type AuthContext, getUserId } from '../../_shared/api/auth.ts';
import { ok, fromError } from '../../_shared/api/respond.ts';
import { validateQuery, validateScope } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { MemoryListParamsSchema } from '../../_shared/schemas/memory.ts';
import { createTracedClient, type Span } from '../../_shared/otel.ts';
import { applyTenantScope } from '../../_shared/tenant-scope.ts';

async function memberOrgIds(db: ReturnType<typeof createClient>, userId: string): Promise<string[]> {
  const { data, error } = await db.rpc('lorekit_member_org_ids', { p_user_id: userId });
  return error ? [] : ((data ?? []) as string[]);
}

export async function handleList(
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  _params: Record<string, string>,
): Promise<Response> {
  const parsed = validateQuery(req, MemoryListParamsSchema);
  if (!parsed.ok) return parsed.error;
  const p = parsed.data;

  // Validate scope if provided
  let normalizedScope: string | undefined;
  if (p.scope) {
    const scopeResult = validateScope(p.scope);
    if (!scopeResult.ok) return scopeResult.error;
    normalizedScope = scopeResult.data;
  }

  span.setAttributes({
    'lorekit.rest.action': 'list',
    ...(normalizedScope ? { 'lorekit.scope': normalizedScope } : {}),
    'lorekit.rest.limit': p.limit,
  });

  try {
    const userId = getUserId(auth);
    const tracedDb = createTracedClient(db, span);
    const cursor = decodeCursor(p.cursor);

    const SELECT =
      'id,scope,key,value,tags,source_agent,trigger,org_id,created_at,updated_at,expires_at,archived_at';

    // Fetch limit+1 to detect hasMore
    let query = tracedDb
      .from('memories')
      .select(SELECT)
      .is('archived_at', null)
      .or('expires_at.is.null,expires_at.gt.now()')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(p.limit + 1);

    // Scope + key filtering
    if (normalizedScope) query = query.eq('scope', normalizedScope);
    if (p.key) query = query.eq('key', p.key);

    // Tag filter (any match)
    const tags = Array.isArray(p.tags)
      ? p.tags
      : typeof p.tags === 'string'
        ? p.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
    if (tags.length > 0) query = query.overlaps('tags', tags);

    // Apply tenant scope — CRITICAL for api_key auth (service-role client bypasses RLS)
    if (userId) {
      const orgIds = await memberOrgIds(db, userId);
      query = applyTenantScope(query, userId, orgIds);
    }

    // Cursor keyset: rows older/smaller than the cursor position
    if (cursor) {
      query = query.or(
        `updated_at.lt.${cursor.t},and(updated_at.eq.${cursor.t},id.lt.${cursor.id})`,
      );
    }

    const { data, error } = await query;
    if (error) {
      span.error(`ListError: ${error.message}`);
      return fromError(error, 'list');
    }

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const page = buildPage(rows, p.limit, (row) => ({
      t: row['updated_at'] as string,
      id: row['id'] as string,
    }));

    span.setAttributes({ 'lorekit.result.count': page.entries.length });
    return ok(page);
  } catch (err) {
    return fromError(err, 'list');
  }
}
