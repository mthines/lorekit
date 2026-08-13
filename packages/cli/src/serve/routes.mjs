// Route table for `lorekit serve`'s local REST shim — delegates to the
// resolved local store plus the pure reducers in this directory. Mirrors the
// subset of `supabase/functions/memories/` the Lore Explorer + scope tree
// need (plan's Technical Approach): list/filter/paginate, scopes, facets,
// activity, get/patch one row (via the synthetic id), archive/restore.
//
// Every response body is shaped to match `@lorekit/schemas`'s
// `MemoryPageResponse` / `ScopesResponse` / `FacetsResponse` /
// `ActivityResponse` / `MemoryEntry` exactly (R6) — proven in
// `test/serve.test.mjs`, which parses every response through the real zod
// schema.
//
// Zero-dependency: no imports outside this directory.
import { memoryEntryFromLocal } from './memory-entry.mjs';
import { resolveSyntheticId } from './synthetic-id.mjs';
import { applyFilters } from './rowFilter.mjs';
import { paginate } from './paginate.mjs';
import { computeFacets } from './facets.mjs';
import { computeActivity } from './activity.mjs';

const ERROR_HEADERS = { 'Content-Type': 'application/json' };

function json(status, body) {
  return { status, headers: ERROR_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) };
}

function noContent() {
  return { status: 204, headers: {}, body: undefined };
}

function badRequest(message) {
  return json(400, { error: message, code: 'bad_request' });
}

function notFound(resource = 'Resource') {
  return json(404, { error: `${resource} not found`, code: 'not_found' });
}

function clampLimit(raw, { def = 50, max = 100 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * Build the route dispatcher over one resolved store.
 *
 * `store` is a `LocalStore`/`TwoTierStore` (from `store/local.mjs`) — anything
 * implementing `listRaw`/`write`/`delete`/`restore`/`listScopes`. Returns
 * `dispatch(method, pathname, query, body)`, an async function producing
 * `{ status, headers, body }` (`body` is a JSON string or `undefined`) — the
 * shape `http.mjs` writes straight onto the response.
 */
export function createRoutes({ store }) {
  async function allRows() {
    const { entries } = await store.listRaw({});
    return entries;
  }

  async function allEntries() {
    return (await allRows()).map(memoryEntryFromLocal);
  }

  async function handleList(query) {
    const entries = await allEntries();
    const filtered = applyFilters(entries, query);
    const sort = query.sort === 'created_at' ? 'created_at' : 'updated_at';
    const page = paginate(filtered, { sort, limit: clampLimit(query.limit), cursor: query.cursor || null });
    return json(200, { entries: page.entries, hasMore: page.hasMore, nextCursor: page.nextCursor });
  }

  async function handleScopes() {
    const scopes = await store.listScopes();
    const sorted = [...scopes].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
    return json(200, { scopes: sorted.map(({ scope, count }) => ({ scope, count })) });
  }

  async function handleFacets(query) {
    const entries = await allEntries();
    const facets = computeFacets(entries, query);
    return json(200, { facets });
  }

  async function handleActivity(query) {
    const entries = await allEntries();
    const bucket = query.bucket === 'hour' ? 'hour' : 'day';
    const activity = computeActivity(entries, { bucket, since: query.since, until: query.until });
    return json(200, activity);
  }

  async function handleGetOne(id) {
    const rows = await allRows();
    const row = resolveSyntheticId(id, rows);
    if (!row) return notFound('Memory');
    // Mirror `handleGet`'s visibility guard — archived/expired rows 404, same
    // as GET /memories' default partition.
    if (row.archived_at != null) return notFound('Memory');
    if (row.expires_at && !(row.expires_at > new Date().toISOString())) return notFound('Memory');
    return json(200, memoryEntryFromLocal(row));
  }

  async function handleUpdate(id, body) {
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return badRequest('PATCH body must contain at least one field');
    }
    const rows = await allRows();
    const existing = resolveSyntheticId(id, rows);
    // Mirror `handleUpdate`'s `.is('archived_at', null)` guard — a PATCH never
    // resurrects an archived row; use POST /memories/:id/restore for that.
    if (!existing || existing.archived_at != null) return notFound('Memory');

    const writeArgs = { scope: existing.scope, key: existing.key };
    if (body.value !== undefined) writeArgs.value = body.value;
    if (body.tags !== undefined) writeArgs.tags = body.tags;
    if (body.source_agent !== undefined) writeArgs.source_agent = body.source_agent;
    if (body.trigger !== undefined) writeArgs.trigger = body.trigger;
    // TTL intentions, never columns (AC-8 / the web-reads-go-through-rest-api
    // lesson) — `store.write` already owns this translation (ttl.mjs).
    if (body.clear_ttl) writeArgs.clear_ttl = true;
    else if (typeof body.ttl_days === 'number') writeArgs.ttl_days = body.ttl_days;

    const result = await store.write(writeArgs);
    if (!result.ok) return badRequest(result.error || 'Update failed');
    return json(200, memoryEntryFromLocal(result.entry));
  }

  async function handleDelete(query) {
    const { scope, key } = query;
    if (!scope || !key) return badRequest('Provide both scope and key query params');
    const forced = query.force === 'true';

    const rows = await allRows();
    const existing = rows.find((r) => r.scope === scope && r.key === key);
    if (!existing) return notFound('Memory');
    // Soft-archive is NOT constrained-to-repeat: an already-archived row has no
    // match for the soft branch (mirrors REST's `.is('archived_at', null)`
    // guard) — force is the path for acting on an already-archived row.
    if (!forced && existing.archived_at != null) return notFound('Memory');

    const result = await store.delete({ scope, key, force: forced });
    const success = forced ? result.deleted : result.archived;
    if (!success) return notFound('Memory');
    return noContent();
  }

  async function handleRestore(body) {
    const scope = body && body.scope;
    const key = body && body.key;
    if (!scope || !key) return badRequest('Provide both scope and key');

    const rows = await allRows();
    const existing = rows.find((r) => r.scope === scope && r.key === key);
    // Restoring a live (never-archived) row is a no-match, mirroring REST's
    // `.not('archived_at', 'is', null)` guard — 404, not a silent no-op.
    if (!existing || existing.archived_at == null) return notFound('Archived memory');

    await store.restore({ scope, key });
    return json(200, { restored: true });
  }

  /**
   * Dispatch one request. `pathname` is ALREADY stripped of the
   * `/functions/v1` base path by `http.mjs` — every path here starts with
   * `/memories`, matching `restBaseUrl()`'s contract.
   */
  return async function dispatch(method, pathname, query = {}, body = undefined) {
    const segments = pathname.split('/').filter(Boolean);

    if (segments[0] !== 'memories') return notFound('Route');

    // Literal routes first (mirrors memories/index.ts's route-order comment):
    // `/scopes`, `/facets`, `/activity`, `/restore` are one segment, exactly
    // like `/:id` — checking the literal name first is what stops a future
    // `/:id` route from swallowing them.
    if (segments.length === 1) {
      if (method === 'GET') return handleList(query);
      if (method === 'DELETE') return handleDelete(query);
      return notFound('Route');
    }

    if (segments.length === 2) {
      const [, second] = segments;
      if (second === 'scopes' && method === 'GET') return handleScopes();
      if (second === 'facets' && method === 'GET') return handleFacets(query);
      if (second === 'activity' && method === 'GET') return handleActivity(query);
      if (second === 'restore' && method === 'POST') return handleRestore(body);
      // Anything else at this depth is the `/:id` form.
      if (method === 'GET') return handleGetOne(second);
      if (method === 'PATCH') return handleUpdate(second, body);
      return notFound('Route');
    }

    return notFound('Route');
  };
}
