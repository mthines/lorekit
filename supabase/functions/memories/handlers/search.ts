import type { AuthContext } from '../../_shared/api/auth.ts';
import { ok, forbidden } from '../../_shared/api/respond.ts';
import { validateBody } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { TracedQuery, Span } from '../../_shared/telemetry/otel.ts';
import { SearchMemoriesBodySchema, MEMORY_SELECT, shapeMemoryRow } from '../../_shared/schemas/memory.ts';
import { normalizeTagList, pgArrayLiteral } from '../../_shared/schemas/tags.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Tables } from '../../_shared/db/database.types.ts';
import { getMemberOrgIds, applyRestTenantScope, firstDeniedScope } from '../../_shared/api/tenant.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { applyFilter } from '../../_shared/api/filter.ts';

type MemoryRow = Tables<'memories'>;

export async function handleSearch(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = await validateBody(req, SearchMemoriesBodySchema, cors);
  if (!v.ok) return v.response;
  const body = v.data;

  span.setAttributes({ 'lorekit.operation': 'memories.search', ...(body.q ? { 'lorekit.query': body.q } : {}), 'lorekit.filtered': body.filter !== undefined, 'lorekit.limit': body.limit });

  const tracedDb = createTracedClient(db, span);

  let q: TracedQuery<MemoryRow> = tracedDb
    .from('memories')
    .select(MEMORY_SELECT)
    .is('archived_at', null)
    .or('expires_at.is.null,expires_at.gt.now()')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(body.limit + 1);

  // api_key auth uses service-role client (bypasses RLS) — apply tenant filter.
  // JWT auth uses RLS-scoped client — RLS handles visibility automatically.
  if (auth.type === 'api_key' && auth.userId) {
    const orgIds = await getMemberOrgIds(db, auth.userId, span);
    q = applyRestTenantScope(q, auth.userId, orgIds, keyRestriction(auth));
  }
  if (body.q) q = q.textSearch('fts', body.q, { type: 'websearch', config: 'english' });
  // Early refusal for a NAMED scope outside the key's allowlist (00068): a
  // plain 403 beats an empty page, which reads as "there is nothing there".
  const deniedScope = firstDeniedScope(auth, body.scopes ?? []);
  if (deniedScope !== null) {
    span.setAttributes({ 'authz.result': 'denied', 'authz.reason': 'key_scope_denied' });
    return forbidden(
      `This token is not allowed to use the scope "${deniedScope}". It is restricted to specific scopes.`,
      cors,
    );
  }

  if (body.scopes?.length) q = q.in('scope', body.scopes);
  // A STRING array literal, never a string[] — postgrest-js joins an array with
  // a bare `,`, which mis-parses a label containing a comma/brace/quote into
  // several labels (`@lorekit/schemas/tags`), and `memories.tags` has no CHECK.
  // Reachable HERE in a way `GET /memories?tags=` is not: that wire format
  // splits on commas, while this JSON body carries such a label verbatim.
  const tags = normalizeTagList(body.tags);
  if (tags.length) q = q.overlaps('tags', pgArrayLiteral(tags));
  // OR+AND structured filter tree — whitelisted fields only (see _shared/api/filter.ts)
  if (body.filter) q = applyFilter(q, body.filter);
  if (body.cursor) { const c = decodeCursor(body.cursor); if (c && c.sort === 'updated_at') q = q.or(`updated_at.lt.${c.ts},and(updated_at.eq.${c.ts},id.lt.${c.id})`); }

  const { data, error } = await q;
  if (error) { span.error(`DB: ${error.message}`); throw error; }
  const page = buildPage(data ?? [], body.limit);
  span.setAttributes({ 'lorekit.result_count': page.entries.length });
  // Record count for the router's usage event — see RESULT_COUNT_HEADER.
  const res = ok({ ...page, entries: page.entries.map(shapeMemoryRow) }, cors);
  res.headers.set('X-LoreKit-Result-Count', String(page.entries.length));
  // Scope attribution for the router's usage event — see SCOPE_COUNT_HEADER /
  // RESOLVED_SCOPE_HEADER (migration 00076). The router cannot read `scopes`
  // itself (it must not consume this POST body), so this handler — which just
  // parsed it to run the search — surfaces it back the same way it already
  // surfaces the result count. A search over exactly one scope is as
  // attributable as a singular `?scope=` filter; over several, only the count
  // is honest.
  if (body.scopes?.length) {
    res.headers.set('X-LoreKit-Scope-Count', String(body.scopes.length));
    if (body.scopes.length === 1) res.headers.set('X-LoreKit-Resolved-Scope', body.scopes[0]);
  }
  return res;
}
