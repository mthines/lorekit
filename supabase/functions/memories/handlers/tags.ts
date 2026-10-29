import type { AuthContext } from '../../_shared/api/auth.ts';
import { keyRestriction } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { createTracedClient } from '../../_shared/telemetry/otel.ts';
import type { Span } from '../../_shared/telemetry/otel.ts';
import type { DbClient } from '../../_shared/api/auth.ts';
import type { Database } from '../../_shared/db/database.types.ts';
import { ListTagsQuerySchema } from '../../_shared/schemas/memory.ts';

/**
 * One element of the catalog. `lorekit_memory_tag_catalog` returns
 * `lorekit_memory_tags`' rows as a jsonb array, so an element has exactly a
 * row's shape; the generated types can only call a jsonb result `Json`.
 */
type TagRow = Database['public']['Functions']['lorekit_memory_tags']['Returns'][number];

/**
 * GET /memories/tags — every distinct label the caller can see, with how many
 * memories carry it, ordered count desc then label asc.
 *
 * This is `GET /memories/scopes` for the second unbounded dimension, and it
 * exists for the same reason: the dashboard used to build its label catalog by
 * selecting `tags` and tallying in the browser, which PostgREST silently
 * truncates past its row cap — so a label used only by older memories
 * disappears from its own filter, with no error and no truncation signal. One
 * grouped row per label from the database is exact at any size.
 *
 * `?archived=true` selects the archived partition, exactly as it does on
 * `GET /memories`. The catalog has to describe the population it will be used
 * to filter: active and archived are different populations, so a catalog
 * pinned to one describes the wrong counts (and hides archive-only labels) in
 * the other.
 *
 * Tenant scoping lives in the RPC (`lorekit_memory_tags`, migration 00050),
 * which composes `lorekit_member_org_ids` exactly as the memories RLS read
 * policies do — so, as with `handleScopes`, there is deliberately no
 * `applyRestTenantScope` call here: there is no query to scope, and a second
 * predicate would be a place for the two to drift.
 */
export async function handleTags(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const validated = validateQuery(req, ListTagsQuerySchema, cors);
  if (!validated.ok) return validated.response;
  const archived = validated.data.archived === 'true';

  span.setAttributes({ 'lorekit.operation': 'memories.tags', 'lorekit.archived': validated.data.archived });

  const tracedDb = createTracedClient(db, span);
  // `lorekit_memory_tag_catalog` (00118), not `lorekit_memory_tags`: the same
  // rows as ONE jsonb array. PostgREST caps a set-returning result at
  // `max_rows` (1000) without an error, and the set is ordered count desc, so
  // an account with more than 1000 labels silently lost its rarest ones — the
  // row-cap bug this endpoint was built to fix, one hop further down. A scalar
  // result is not capped (00117 found the same cut on /facets).
  //
  // Service-role callers have no user id; the RPC recognises a null p_user_id
  // from a service_role JWT as "no tenant filter", matching GET /memories.
  const { data, error } = await tracedDb.rpc<TagRow[] | null>('lorekit_memory_tag_catalog', {
    p_user_id: auth.userId ?? null,
    p_archived: archived,
    // The calling key's restriction (00068/00069). Narrowed inside the RPC for
    // the same reason `/scopes` and the activity series are: this is an
    // aggregate over rows, so there is nothing out here to post-filter.
    p_key_scopes: keyRestriction(auth)?.scopes ?? [],
    p_key_org_access: keyRestriction(auth)?.orgAccess ?? 'all',
    p_key_org_ids: keyRestriction(auth)?.orgIds ?? [],
  });
  if (error) { span.error(`DB: ${error.message}`); throw error; }

  const tags = (data ?? []).map((r) => ({ tag: r.tag, count: Number(r.count) }));
  span.setAttributes({ 'lorekit.result_count': tags.length });
  return ok({ tags }, cors);
}
