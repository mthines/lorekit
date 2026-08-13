// Pure drill-down + self-exclusion facet reducer over an in-memory row array —
// the local-store counterpart of `lorekit_memory_facets`
// (supabase/migrations/00057_memory_facets_drilldown.sql), reimplemented here
// because a SQL function cannot be imported into Node (see plan's Existing
// Code Survey).
//
// THE SELF-EXCLUSION RULE (00057's own docblock, restated for this
// reimplementation): when counting a dimension D's values, apply every OTHER
// active filter but NOT D's own. If D's own selection were applied to D's own
// counts, D would collapse to just the value(s) already picked and every
// other value would read 0 — the user could never discover what else they
// could switch to. This is "OR within a dimension, AND across dimensions",
// the same model `ListMemoriesQuerySchema`'s `*_mode` filters use.
//
// HOW: for each row, compute a per-dimension "does this row satisfy THIS
// dimension's filter?" flag once (mirroring the SQL migration's `base` CTE).
// A dimension's cells are then counted over rows where every OTHER flag is
// true — an unfiltered dimension's flag is trivially true, so with no filters
// at all every flag is true and the result is the global catalog, unchanged.
//
// Zero-dependency: no imports except the row-filter's `parseList` (also
// zero-dep), so the two modules cannot disagree about how a comma-list splits.
import { parseList } from './rowFilter.mjs';

/** The eight facet names, in the SQL migration's `facet asc` order. */
export const FACET_NAMES = ['tag', 'source_agent', 'trigger', 'kind', 'host', 'origin_repo', 'origin_branch', 'origin_pr'];

// Map a facet name to the row field(s) it draws from and the *_mode/param
// pair a caller's active filters use. `tag` is multi-valued per row (the
// `cross join lateral unnest` branch in SQL); every other facet is scalar.
const SCALAR_DIMENSIONS = [
  { facet: 'source_agent', field: 'source_agent', param: 'source_agent', mode: 'source_agent_mode' },
  { facet: 'trigger', field: 'trigger', param: 'trigger', mode: 'trigger_mode' },
  { facet: 'kind', field: 'kind', param: 'kind', mode: 'kind_mode' },
  { facet: 'host', field: 'host', param: 'host', mode: 'host_mode' },
  { facet: 'origin_repo', field: 'origin_repo', param: 'origin_repo', mode: 'origin_repo_mode' },
  { facet: 'origin_branch', field: 'origin_branch', param: 'origin_branch', mode: 'origin_branch_mode' },
];

function matchesScalarOk(value, wanted, mode) {
  if (wanted.length === 0) return true; // not filtered → trivially true
  if (mode === 'nin') return value != null && !wanted.includes(value);
  return value != null && wanted.includes(value);
}

function matchesOriginPrOk(value, wanted, mode) {
  const numeric = wanted.map(Number).filter(Number.isFinite);
  if (numeric.length === 0) return true;
  if (mode === 'nin') return value != null && !numeric.includes(value);
  return value != null && numeric.includes(value);
}

function matchesTagOk(tags, wanted, mode) {
  if (wanted.length === 0) return true;
  const list = Array.isArray(tags) ? tags : [];
  const has = (t) => list.includes(t);
  if (mode === 'all') return wanted.every(has);
  if (mode === 'none') return !wanted.some(has);
  return wanted.some(has);
}

/**
 * Compute the row-scoped tenant/liveness base — the archived partition and
 * (for `archived=false`) the same `applyFilters` liveness rule, so the facet
 * catalog describes the same population `GET /memories` would filter, exactly
 * as the migration's docblock requires (`p_archived` partitions).
 *
 * `scope` is a HARD filter here (never self-excluded) — mirroring the SQL's
 * `and (p_scope is null or m.scope = p_scope)` outside the `ok_*` flags.
 */
function baseRows(rows, { archived, scope, now }) {
  return rows.filter((row) => {
    if (archived) {
      if (row.archived_at == null) return false;
    } else {
      if (row.archived_at != null) return false;
      if (row.expires_at && !(row.expires_at > now)) return false;
    }
    if (scope && row.scope !== scope) return false;
    return true;
  });
}

/**
 * `GET /memories/facets` over an in-memory row array.
 *
 * `params` carries the SAME field names `ListMemoriesQuerySchema`/
 * `ListFacetsQuerySchema` use (`tags`/`tags_mode`, `source_agent`/
 * `source_agent_mode`, …) so `routes.mjs` can pass the request's query object
 * straight through. Returns `[{ facet, value, count }]`, sorted `facet asc,
 * count desc, value asc` — the same order the SQL migration returns, so a
 * caller that reshuffles for equal counts is reading a real bug.
 */
export function computeFacets(rows, params = {}, now = new Date().toISOString()) {
  const archived = params.archived === 'true' || params.archived === true;
  const rowsInScope = baseRows(rows, { archived, scope: params.scope, now });

  const wantedTags = parseList(params.tags);
  const tagsMode = params.tags_mode || 'any';
  const scalarWanted = new Map(
    SCALAR_DIMENSIONS.map((d) => [d.facet, { wanted: parseList(params[d.param]), mode: params[d.mode] || 'in' }]),
  );
  const originPr = { wanted: parseList(params.origin_pr), mode: params.origin_pr_mode || 'in' };

  // Per-row per-dimension "ok" flags (the SQL migration's `base` CTE).
  const withFlags = rowsInScope.map((row) => {
    const flags = { tag: matchesTagOk(row.tags, wantedTags, tagsMode) };
    for (const d of SCALAR_DIMENSIONS) {
      const { wanted, mode } = scalarWanted.get(d.facet);
      flags[d.facet] = matchesScalarOk(row[d.field], wanted, mode);
    }
    flags.origin_pr = matchesOriginPrOk(row.origin_pr, originPr.wanted, originPr.mode);
    return { row, flags };
  });

  const counts = new Map(); // `${facet}\x00${value}` -> count

  const bump = (facet, value) => {
    if (value == null) return;
    const v = String(value).trim();
    if (!v) return;
    const k = `${facet}\x00${v}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  };

  const otherFlagsOk = (flags, excludeFacet) =>
    FACET_NAMES.every((f) => f === excludeFacet || flags[f]);

  for (const { row, flags } of withFlags) {
    if (otherFlagsOk(flags, 'tag')) {
      for (const t of Array.isArray(row.tags) ? row.tags : []) bump('tag', t);
    }
    for (const d of SCALAR_DIMENSIONS) {
      if (otherFlagsOk(flags, d.facet)) bump(d.facet, row[d.field]);
    }
    if (otherFlagsOk(flags, 'origin_pr')) bump('origin_pr', row.origin_pr == null ? null : String(row.origin_pr));
  }

  const out = [];
  for (const [k, count] of counts) {
    const nul = k.indexOf('\x00');
    out.push({ facet: k.slice(0, nul), value: k.slice(nul + 1), count });
  }
  out.sort((a, b) => {
    if (a.facet !== b.facet) return a.facet < b.facet ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });

  // `?facets=` narrows the response to named dimensions — an unknown name
  // narrows to nothing rather than 400ing (the same "hand-editable URL, one
  // typo must not break the page" reasoning the edge handler documents).
  const named = parseList(params.facets);
  if (named.length === 0) return out;
  const requested = new Set(named.filter((f) => FACET_NAMES.includes(f)));
  return out.filter((row) => requested.has(row.facet));
}
