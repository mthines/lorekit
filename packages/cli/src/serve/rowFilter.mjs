// Pure list-filter predicate mirroring `ListMemoriesQuerySchema`'s semantics
// (packages/schemas/src/memory.ts) over an in-memory array of already-
// translated `MemoryEntry`-shaped rows (see memory-entry.mjs).
//
// Unlike the edge handler (`supabase/functions/memories/handlers/list.ts`),
// which builds a PostgREST query, this filters a plain JS array — the local
// store is small enough that "hold every row in memory and filter" is the
// right shape, and it means the ENCODING problems the edge handler solves
// (LIKE-escaping, PostgREST logic-tree quoting) simply do not exist here: a
// substring match is `String.includes`, nothing needs escaping for a JS
// string comparison.
//
// Zero-dependency: no imports.

/** Split a comma-separated value list, trimming and dropping empties — the
 * one splitting rule for every list-valued query param, mirroring
 * `@lorekit/schemas/tags`'s `parseTagsParam` (not imported: the CLI stays
 * zero-dependency; re-derived here like `ttl.mjs` re-derives `ttl.ts`). */
export function parseList(raw) {
  if (raw == null || raw === '') return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function lower(s) {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

/** `tags_mode` semantics: any = overlap, all = containment, none = negation of any. */
function matchesTags(rowTags, wanted, mode) {
  if (wanted.length === 0) return true;
  const tags = Array.isArray(rowTags) ? rowTags : [];
  const has = (t) => tags.includes(t);
  if (mode === 'all') return wanted.every(has);
  if (mode === 'none') return !wanted.some(has);
  return wanted.some(has); // any (default)
}

/** A scalar multi-value filter (source_agent/trigger/kind/host/origin_repo/
 * origin_branch): `in` = disjunction, `nin` = its negation. Mirrors the edge
 * handler's `not.in` semantics — a null column value never matches `nin`'s
 * "must differ from every named value" (it fails the comparison, same as SQL
 * NULL), which is exactly what a "does not carry this value" filter should do
 * for a row that carries no value at all. */
function matchesScalar(rowValue, wanted, mode) {
  if (wanted.length === 0) return true;
  if (mode === 'nin') return rowValue != null && !wanted.includes(rowValue);
  return rowValue != null && wanted.includes(rowValue);
}

/** `origin_pr` is numeric; the wire's digits-only list may be zero-padded
 * ("007"), so compare numerically — mirroring the RPC's `::integer` cast. A
 * list that reduces to no numeric entries applies no filter at all (the list
 * route's documented behaviour: one bad entry narrows, it never 400s). */
function matchesOriginPr(rowValue, wanted, mode) {
  const numeric = wanted.map(Number).filter(Number.isFinite);
  if (numeric.length === 0) return true;
  if (mode === 'nin') return rowValue != null && !numeric.includes(rowValue);
  return rowValue != null && numeric.includes(rowValue);
}

/** Case-insensitive substring over key OR value — the `?q=` as-you-type filter. */
function matchesQ(row, q) {
  if (!q) return true;
  const needle = lower(q);
  return lower(row.key).includes(needle) || lower(row.value).includes(needle);
}

/** Case-insensitive PREFIX match on `key`, distinct from the exact `key` filter. */
function matchesKeyPrefix(row, prefix) {
  if (!prefix) return true;
  return lower(row.key).startsWith(lower(prefix));
}

/** Half-open [since, until) window on `created_at`. */
function matchesCreatedWindow(row, since, until) {
  const created = row.created_at;
  if (since && created < since) return false;
  if (until && !(created < until)) return false;
  return true;
}

/**
 * "Expiring soon": `expires_at` in `(now, now + N days]`, mirroring the edge
 * handler's `expiringWindow`. A row with no TTL (`expires_at: null`) never
 * matches — there is nothing to compare, same as the SQL `null > x` failing.
 */
export function expiringWindow(days, nowIso) {
  const now = new Date(nowIso ?? new Date().toISOString());
  const after = now.toISOString();
  const onOrBefore = new Date(now.getTime() + days * 86_400_000).toISOString();
  return { after, onOrBefore };
}

function matchesExpiringWithinDays(row, days, nowIso) {
  if (days === undefined || days === null) return true;
  if (!row.expires_at) return false;
  const { after, onOrBefore } = expiringWindow(days, nowIso);
  return row.expires_at > after && row.expires_at <= onOrBefore;
}

/**
 * The live/archived partition, mirroring `handleList`'s `isArchived` branch:
 * `archived=true` → only archived rows; `archived=false` (default) → rows
 * that are neither archived nor expired.
 */
function matchesArchivedPartition(row, archived, nowIso) {
  if (archived) return row.archived_at != null;
  if (row.archived_at != null) return false;
  if (!row.expires_at) return true;
  return row.expires_at > (nowIso ?? new Date().toISOString());
}

/**
 * Apply every `GET /memories` filter param to a row array — every dimension
 * `ListMemoriesQuerySchema` defines. `params` is the already-validated query
 * object (or a plain object with the same field names for direct unit
 * testing); `now` (ISO string) is injectable for deterministic expiry tests.
 */
export function applyFilters(rows, params = {}, now = new Date().toISOString()) {
  const archived = params.archived === 'true' || params.archived === true;

  return rows.filter((row) => {
    if (!matchesArchivedPartition(row, archived, now)) return false;
    if (params.scope && row.scope !== params.scope) return false;
    if (params.key && row.key !== params.key) return false;
    if (!matchesKeyPrefix(row, params.key_prefix)) return false;
    if (!matchesTags(row.tags, parseList(params.tags), params.tags_mode || 'any')) return false;
    if (!matchesScalar(row.source_agent, parseList(params.source_agent), params.source_agent_mode || 'in')) return false;
    if (!matchesScalar(row.trigger, parseList(params.trigger), params.trigger_mode || 'in')) return false;
    if (!matchesScalar(row.kind, parseList(params.kind), params.kind_mode || 'in')) return false;
    if (!matchesScalar(row.host, parseList(params.host), params.host_mode || 'in')) return false;
    if (!matchesScalar(row.origin_repo, parseList(params.origin_repo), params.origin_repo_mode || 'in')) return false;
    if (!matchesScalar(row.origin_branch, parseList(params.origin_branch), params.origin_branch_mode || 'in')) return false;
    if (!matchesOriginPr(row.origin_pr, parseList(params.origin_pr), params.origin_pr_mode || 'in')) return false;
    if (!matchesQ(row, params.q)) return false;
    if (!matchesCreatedWindow(row, params.created_since, params.created_until)) return false;
    if (!matchesExpiringWithinDays(row, params.expiring_within_days, now)) return false;
    return true;
  });
}
