/**
 * Pure logic for the Lore Explorer's filter bar.
 *
 * This is `tag-filter.ts` generalised. The Explorer used to filter on exactly
 * one dimension (labels), so a single multi-select popover was the whole
 * story. It now filters on nine — label, kind, host, owner, agent, trigger,
 * repo, branch, pull request — which is a different problem: one control per
 * dimension would put nine triggers in a row that is already crowded, and would
 * still not answer "what can I filter by?" for the next dimension after that.
 *
 * The model is Linear's, because it is the one that scales: a **filter bar** of
 * committed conditions, each rendered as a three-segment pill, fed by ONE
 * two-level command menu (pick a dimension → pick values). Semantics are
 * Linear's too — **OR within a dimension, AND across dimensions** — which is
 * the only combination a flat pill row can render without inventing a
 * precedence grammar. Anything richer belongs in `POST /memories/search`'s
 * filter tree.
 *
 * Kept dependency-free (no React, no network) so every decision the bar makes
 * is unit-testable in the node vitest project, mirroring `tag-filter.ts` and
 * `org-ui.ts`. The impure shells are `components/lore/FilterMenu.tsx` (the
 * menu), `components/lore/FilterPill.tsx` (the pills) and the `useMemories`
 * query that consumes {@link filtersToBody} — the BODY transport, because a
 * filter bar's value sets are unbounded and a query string caps each dimension
 * at 2048 characters. {@link filtersToQueryParams} is the equivalent GET
 * encoding, still exported for the query-string callers.
 */

import { normalizeTagList } from '@lorekit/schemas/tags';
import type {
  ActivityBody,
  ListFacetsBody,
  ListFacetsQuery,
  ListMemoriesBody,
  ListMemoriesQuery,
  ScalarFilterMode,
  TagsMode,
} from '@lorekit/schemas/memory';

// ── Model ────────────────────────────────────────────────────────────────────

/** A filterable dimension, named for the user-facing word rather than the column. */
export type FilterField =
  | 'label'
  | 'kind'
  | 'host'
  | 'owner'
  | 'agent'
  | 'trigger'
  | 'repo'
  | 'branch'
  | 'pr';

/**
 * How a dimension's values combine.
 *
 * `in` is the disjunction ("is" / "is either of" / "includes any"), `nin` its
 * negation, and `all` is set containment — legal only for `label`, the one
 * dimension whose column holds MANY values per row, so "carries every one of
 * these" is a question that can be asked at all.
 */
export type FilterOperator = 'in' | 'nin' | 'all';

export interface Filter {
  field: FilterField;
  operator: FilterOperator;
  /** The disjunct values. A filter with no values does not exist — see {@link normalizeFilters}. */
  values: string[];
}

/**
 * The `GET /memories/facets` dimension a field's values are catalogued under.
 *
 * This mirrors `MemoryFacetSchema` (`@lorekit/schemas/memory`) exactly — the
 * endpoint's response is assigned to `FacetValue[]` in `queries/lore.ts`, so a
 * dimension the server can emit and this union cannot name is a type error, not
 * a silent narrowing.
 *
 * It is now one-to-one with {@link FilterField}: `kind` and `host` (migration
 * 00056, catalogued by 00057) were the last two facets the server emitted with
 * no descriptor to map them, so their rows arrived and were silently ignored.
 * They have pills now. Keep the two in step — a facet with no descriptor is not
 * a type error, it is a dimension that quietly does nothing.
 */
export type FacetName =
  | 'tag'
  | 'source_agent'
  | 'trigger'
  | 'kind'
  | 'host'
  | 'origin_repo'
  | 'origin_branch'
  | 'origin_pr'
  // Ownership (migration 00064) — `personal` plus one value per org the caller
  // belongs to, keyed by slug. Folded in from the old client-side owner bar.
  | 'owner';

export interface FilterFieldDescriptor {
  field: FilterField;
  /** The word in the type list and in the pill's first segment. */
  label: string;
  /** Placeholder for the value-list search box. */
  searchPlaceholder: string;
  /** The facet whose values populate this field. */
  facet: FacetName;
  /** Operators offered for this field, in menu order. The first is the default. */
  operators: readonly FilterOperator[];
  /** How a raw value is rendered (a PR number reads as `#482`, not `482`). */
  format: (value: string) => string;
}

/**
 * The dimensions, in menu order.
 *
 * Ordered by how often a dimension is the one you reach for, not
 * alphabetically: labels are the dimension that already existed and still
 * carries most filtering, and the provenance trio (repo / branch / PR) sits
 * together because a user narrowing by one usually narrows by its neighbour
 * next.
 *
 * `label` defaults to `all`, not `in`. That is deliberately NOT Linear's
 * default: it is what the Explorer's label filter has always meant ("shows
 * memories with every selected label"), and silently flipping a live filter's
 * semantics on upgrade would change what an already-shared `?tags=` link
 * returns. `includes any` is one click away in the operator menu.
 */
export const FILTER_FIELDS: readonly FilterFieldDescriptor[] = [
  {
    field: 'label',
    label: 'Label',
    searchPlaceholder: 'Search labels…',
    facet: 'tag',
    operators: ['all', 'in', 'nin'],
    format: (v) => v,
  },
  {
    // The coarsest partition of the store, so it sits high: `bus` events are
    // transient outcome records and `signal`s are per-repo filters, and neither
    // is what someone browsing lessons means to be reading. Its vocabulary is
    // CLOSED (`MemoryKindSchema` — lesson / bus / signal), unlike every other
    // dimension here, so the value list is short by construction and the search
    // box is vestigial rather than load-bearing. That is not worth a second
    // descriptor shape: the facet catalog still supplies the values (and their
    // counts), so a kind nobody has written does not appear, which a hardcoded
    // list of three would get wrong.
    field: 'kind',
    label: 'Kind',
    searchPlaceholder: 'Search kinds…',
    facet: 'kind',
    operators: ['in', 'nin'],
    format: (v) => v,
  },
  {
    // Beside Kind because the two form the phrase the taxonomy exists for —
    // `?kind=lesson&host=reviewer` reads "reviewer's lessons".
    //
    // Distinct from Agent, and deliberately not merged with it: `host` is the
    // skill or agent that OWNS the bucket (`reviewer`, `aw`, `ci-auto-fix`),
    // while `source_agent` is whoever WROTE the row. They usually agree and
    // sometimes do not, which is exactly when you want to be able to ask.
    field: 'host',
    label: 'Host',
    searchPlaceholder: 'Search hosts…',
    facet: 'host',
    operators: ['in', 'nin'],
    format: (v) => v,
  },
  {
    // Ownership — the coarse "whose lore is this" partition, so it sits beside
    // the other identity dimensions. Its value space is CLOSED-ish: `personal`
    // plus one value per org the caller belongs to, keyed by the org SLUG
    // (stable across renames). This used to be a separate client-side bar; it is
    // a server-side facet now (migration 00064), mechanically identical to the
    // scalar dimensions. `format` renders the literal `personal` as `Personal`;
    // an org value is shown by its slug (a follow-up can map it to the org name).
    field: 'owner',
    label: 'Owner',
    searchPlaceholder: 'Search owners…',
    facet: 'owner',
    operators: ['in', 'nin'],
    format: (v) => (v === 'personal' ? 'Personal' : v),
  },
  {
    field: 'agent',
    label: 'Agent',
    searchPlaceholder: 'Search agents…',
    facet: 'source_agent',
    operators: ['in', 'nin'],
    format: (v) => v,
  },
  {
    field: 'trigger',
    label: 'Trigger',
    searchPlaceholder: 'Search triggers…',
    facet: 'trigger',
    operators: ['in', 'nin'],
    format: (v) => v,
  },
  {
    field: 'repo',
    label: 'Repository',
    searchPlaceholder: 'Search repositories…',
    facet: 'origin_repo',
    operators: ['in', 'nin'],
    format: (v) => v,
  },
  {
    field: 'branch',
    label: 'Branch',
    searchPlaceholder: 'Search branches…',
    facet: 'origin_branch',
    operators: ['in', 'nin'],
    format: (v) => v,
  },
  {
    field: 'pr',
    label: 'Pull request',
    searchPlaceholder: 'Search pull requests…',
    facet: 'origin_pr',
    operators: ['in', 'nin'],
    format: (v) => `#${v}`,
  },
];

const FIELD_BY_NAME = new Map(FILTER_FIELDS.map((d) => [d.field, d]));

/** The descriptor for a field, or `undefined` for a name that is not one. */
export function fieldDescriptor(field: string): FilterFieldDescriptor | undefined {
  return FIELD_BY_NAME.get(field as FilterField);
}

/** The descriptor for a field. Throws only on a value the type system forbids. */
export function requireField(field: FilterField): FilterFieldDescriptor {
  const d = FIELD_BY_NAME.get(field);
  if (!d) throw new Error(`Unknown filter field: ${field}`);
  return d;
}

// ── Normalisation ────────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary value — a `?filters=` param a user hand-edited, a stale
 * link from an older release — into a usable filter list.
 *
 * Total function, in `normalizeTagList`'s tradition: anything unusable is
 * dropped rather than thrown, because the alternative is a blank page for a
 * malformed URL. The invariants it establishes, which every consumer below may
 * then assume:
 *
 * - at most one filter per field (a second one for the same field is merged
 *   into the first, because two pills of one dimension have no rendering in a
 *   flat bar and no meaning the operator cannot already express);
 * - values are trimmed, de-duplicated and non-empty;
 * - a filter with no values is removed entirely — an empty pill is a control
 *   that filters nothing and cannot be cleared by the thing it looks like;
 * - the operator is legal for the field, falling back to the field's default.
 */
export function normalizeFilters(raw: unknown): Filter[] {
  if (!Array.isArray(raw)) return [];

  const byField = new Map<FilterField, Filter>();

  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue;
    const { field, operator, values } = candidate as Record<string, unknown>;
    const descriptor = typeof field === 'string' ? fieldDescriptor(field) : undefined;
    if (!descriptor) continue;

    const cleanValues = normalizeTagList(Array.isArray(values) ? values : []);
    if (cleanValues.length === 0) continue;

    const op: FilterOperator =
      typeof operator === 'string' && (descriptor.operators as readonly string[]).includes(operator)
        ? (operator as FilterOperator)
        : (descriptor.operators[0] as FilterOperator);

    const existing = byField.get(descriptor.field);
    if (existing) {
      // Merge rather than drop: a duplicated field in a hand-edited URL most
      // likely means "all of these values", and losing half of them silently
      // is the worse failure.
      existing.values = normalizeTagList([...existing.values, ...cleanValues]);
    } else {
      byField.set(descriptor.field, { field: descriptor.field, operator: op, values: cleanValues });
    }
  }

  // Emit in FILTER_FIELDS order so the pill row is stable across reloads and
  // shared links, rather than reflecting the order values happened to be added.
  return FILTER_FIELDS.map((d) => byField.get(d.field)).filter((f): f is Filter => f !== undefined);
}

/**
 * Translate a legacy `?tags=` selection into a label filter.
 *
 * The Explorer shipped `?tags=["a","b"]` with AND semantics before the filter
 * bar existed, and those links are in PRs, Slack threads and the CLI's
 * `lorekit link` output. `all` — not the menu-neutral `in` — is what those
 * links have always meant.
 */
export function filtersFromLegacyTags(tags: unknown): Filter[] {
  const values = normalizeTagList(Array.isArray(tags) ? tags : []);
  return values.length === 0 ? [] : [{ field: 'label', operator: 'all', values }];
}

/**
 * Translate a legacy `?owner=` selection into an owner filter.
 *
 * Ownership is a server-side facet dimension now (migration 00064), keyed by the
 * `personal` partition or an org SLUG. The legacy `?owner=` param folds into an
 * `owner` filter — the CLI (`lorekit link --owner …`) and the accept-invite deep
 * link write a string here (`personal` or a slug), so any string BUT `all`
 * becomes a one-value owner filter:
 *
 * - `'all'` (or absent) was "no constraint", so it produces no filter.
 * - `'personal'` / a slug string maps straight to that owner facet value.
 * - `{ orgId }` — the pre-00064 OBJECT form — carried the org UUID, and the facet
 *   keys on the stable SLUG, not the id; resolving one to the other needs an org
 *   lookup this pure function has no access to, so it degrades to NO filter
 *   rather than a wrong one. Nothing writes that form any more (the CLI and the
 *   invite link both emit a slug), so only links shared before this change lose
 *   the org pre-selection.
 */
export function filtersFromLegacyOwner(owner: unknown): Filter[] {
  if (typeof owner !== 'string' || !owner || owner === 'all') return [];
  return [{ field: 'owner', operator: 'in', values: [owner] }];
}

/**
 * The bar's filters, given the `?filters=` param and the legacy shorthands.
 *
 * `rawFilters` is `null` when `?filters=` is ABSENT from the URL and an array
 * (possibly empty) when it is present. That distinction is the whole point:
 * "absent" means the user has never touched the bar, so a legacy `?tags=` /
 * `?owner=` link may still speak for it; "present but empty" means the user
 * emptied the bar, and the legacy shorthands must NOT speak over that.
 * Collapsing the two — the bar's first shape — made the last pill on a `?tags=`
 * link unremovable: the write dropped the param, the fallback re-derived the
 * filter, and the × the user had just clicked did nothing. The legacy `?owner=`
 * param rides the same "absent only" rule, so it cannot resurrect an owner pill
 * the user removed once the bar has been touched.
 */
export function resolveFilters(
  rawFilters: unknown,
  legacyTags: unknown,
  legacyOwner: unknown = null,
): Filter[] {
  if (rawFilters === null || rawFilters === undefined) {
    return normalizeFilters([
      ...filtersFromLegacyTags(legacyTags),
      ...filtersFromLegacyOwner(legacyOwner),
    ]);
  }
  return normalizeFilters(rawFilters);
}

/**
 * What to persist to `?filters=` for a new selection — `null` meaning "drop the
 * param".
 *
 * An empty bar is normally worth nothing in the URL, and dropping the param is
 * what keeps a shared link clean. The one exception is a legacy `?tags=` link:
 * there, an empty bar is a STATEMENT ("I removed that filter") that has to
 * survive the reload, so it is written explicitly rather than inferred from an
 * absent param.
 */
export function filtersParamValue(
  next: readonly Filter[],
  legacyTags: unknown,
  legacyOwner: unknown = null,
): Filter[] | null {
  if (next.length > 0) return [...next];
  return filtersFromLegacyTags(legacyTags).length > 0 ||
    filtersFromLegacyOwner(legacyOwner).length > 0
    ? []
    : null;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function findFilter(filters: readonly Filter[], field: FilterField): Filter | undefined {
  return filters.find((f) => f.field === field);
}

/** The values currently selected for a field. Empty when the field has no filter. */
export function selectedValues(filters: readonly Filter[], field: FilterField): string[] {
  return findFilter(filters, field)?.values ?? [];
}

export function isValueSelected(
  filters: readonly Filter[],
  field: FilterField,
  value: string,
): boolean {
  return selectedValues(filters, field).includes(value.trim());
}

/** Total number of committed conditions — what the trigger's count badge shows. */
export function filterCount(filters: readonly Filter[]): number {
  return normalizeFilters(filters as unknown[]).length;
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Add `value` to the field's filter when absent, remove it when present.
 *
 * Creating the filter on first toggle (rather than making the user "add" then
 * "fill") is what makes the menu one continuous gesture. Removing the filter
 * when its last value is toggled off is the same rule from the other end: the
 * pill exists to represent a constraint, so no constraint means no pill.
 */
export function toggleFilterValue(
  filters: readonly Filter[],
  field: FilterField,
  value: string,
): Filter[] {
  const trimmed = value.trim();
  if (!trimmed) return normalizeFilters(filters as unknown[]);

  const current = findFilter(filters, field);
  if (!current) {
    return normalizeFilters([
      ...filters,
      { field, operator: requireField(field).operators[0], values: [trimmed] },
    ]);
  }

  const nextValues = current.values.includes(trimmed)
    ? current.values.filter((v) => v !== trimmed)
    : [...current.values, trimmed];

  return normalizeFilters(
    filters.map((f) => (f.field === field ? { ...f, values: nextValues } : f)),
  );
}

/** Replace a field's operator. A no-op for an operator the field does not offer. */
export function setFilterOperator(
  filters: readonly Filter[],
  field: FilterField,
  operator: FilterOperator,
): Filter[] {
  if (!(requireField(field).operators as readonly string[]).includes(operator)) {
    return normalizeFilters(filters as unknown[]);
  }
  return normalizeFilters(filters.map((f) => (f.field === field ? { ...f, operator } : f)));
}

export function removeFilter(filters: readonly Filter[], field: FilterField): Filter[] {
  return normalizeFilters(filters.filter((f) => f.field !== field));
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The operator's word in the pill.
 *
 * Derived from cardinality for the scalar dimensions, because "Agent is either
 * of claude" reads as a bug and "Agent is claude, aw" reads as a typo. The
 * polarity is preserved across the transition — a negated filter stays negated
 * when a second value is added, it does not silently flip to the positive
 * multi form.
 *
 * `label` gets its own vocabulary because a memory carries MANY labels, so
 * "includes all" is a question with no scalar analogue and "is" would be a lie.
 */
export function operatorLabel(
  field: FilterField,
  operator: FilterOperator,
  valueCount: number,
): string {
  if (field === 'label') {
    if (operator === 'all') return 'includes all';
    if (operator === 'nin') return 'includes none';
    return 'includes any';
  }
  if (operator === 'nin') return 'is not';
  return valueCount > 1 ? 'is either of' : 'is';
}

/**
 * The pill's value segment: the first values named, then `+N`.
 *
 * Names rather than counts, for `tagTriggerLabel`'s reason — "perf +2" tells
 * you what the list is filtered by without opening anything, "3 labels" does
 * not.
 */
export function valueSummary(
  field: FilterField,
  values: readonly string[],
  visible = 2,
): string {
  const { format } = requireField(field);
  const shown = values.slice(0, visible).map(format);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
}

/**
 * The whole condition as one sentence — the pill's accessible name, and what a
 * live region announces when a value is toggled.
 *
 * Never truncated, unlike {@link valueSummary}: a screen-reader user has no
 * `+2` to hover.
 */
export function filterPhrase(filter: Filter): string {
  const { label, format } = requireField(filter.field);
  const op = operatorLabel(filter.field, filter.operator, filter.values.length);
  return `${label} ${op} ${filter.values.map(format).join(', ')}`;
}

/** Every committed condition as one sentence, for the trigger's accessible name. */
export function filtersPhrase(filters: readonly Filter[]): string {
  const normalized = normalizeFilters(filters as unknown[]);
  if (normalized.length === 0) return 'Add filter';
  return normalized.map(filterPhrase).join('; ');
}

// ── Facet options ────────────────────────────────────────────────────────────

/** One row of `GET /memories/facets`. */
export interface FacetValue {
  facet: FacetName;
  value: string;
  count: number;
}

export interface FilterOption {
  value: string;
  /**
   * How many memories carry the value, or `null` when that is unknown — a
   * selected value the catalog does not cover. Renderers show a count only for
   * a real number; inventing `0` would state something false about the data.
   */
  count: number | null;
}

/**
 * The option list for one dimension: the catalog, plus any selected value the
 * catalog does not cover, appended with `count: null`.
 *
 * The uncatalogued tail is `tagOptions`' guarantee, kept: a value that arrived
 * from a shared link but no longer matches anything must still have a row to
 * switch it off. An active filter you can only clear by hand-editing the URL is
 * the one state this control must never reach.
 *
 * Catalog order (count desc, then value asc — the server's) is preserved and
 * selected options are NOT hoisted: a list that reorders on every toggle moves
 * the next option out from under the pointer mid-click.
 */
export function facetOptions(
  facets: readonly FacetValue[],
  field: FilterField,
  selected: readonly string[],
): FilterOption[] {
  const facet = requireField(field).facet;
  const catalog = facets.filter((f) => f.facet === facet);
  const known = new Set(catalog.map((f) => f.value));
  const uncatalogued = normalizeTagList(selected)
    .filter((v) => !known.has(v))
    .map((value) => ({ value, count: null }));

  return [...catalog.map(({ value, count }) => ({ value, count })), ...uncatalogued];
}

/**
 * Narrow an option list by the search box: case-insensitive literal substring.
 *
 * Substring rather than prefix or fuzzy, for `searchTags`' reason — these
 * values are frequently namespaced (`ci/flaky`, `feat/explorer-filters`,
 * `mthines/lorekit`), so the memorable fragment is usually in the middle. The
 * query is matched literally; no regex is ever compiled from user input.
 */
export function searchOptions(
  options: readonly FilterOption[],
  query: string,
): FilterOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((o) => o.value.toLowerCase().includes(needle));
}

/** A dimension row in the menu's first level. */
export interface FieldSuggestion {
  kind: 'field';
  field: FilterField;
}

/** A `Dimension → value` row: one keystroke straight to a committed condition. */
export interface ValueSuggestion {
  kind: 'value';
  field: FilterField;
  value: string;
  count: number;
}

export type RootSuggestion = FieldSuggestion | ValueSuggestion;

/** How many cross-dimension value hits the root level offers before it stops. */
export const ROOT_VALUE_LIMIT = 8;

/**
 * The first level's rows for a given query.
 *
 * With no query it is just the dimension list. With one it is the matching
 * dimensions FIRST, then matching values from every dimension — this is the
 * affordance that makes the two-level structure cost the expert nothing: type
 * `main`, get `Branch → main`, press Enter, done, without ever choosing
 * "Branch". Values are fully qualified with their dimension so the row is never
 * ambiguous, and they are capped because the value space is unbounded and an
 * uncapped list turns the menu into a scrollbar.
 *
 * Ranking, most to least specific: exact dimension-name match, dimension-name
 * prefix, dimension-name substring, then values — **one dimension at a time,
 * round-robin, each dimension's values in catalog order** (which is count desc
 * within that dimension, so the popular value is the likely one).
 *
 * The round-robin is what makes the cap survivable. `GET /memories/facets`
 * returns its rows `facet asc, count desc, value asc` (migration 00052), so
 * draining the catalog in arrival order spends the whole cap on
 * `origin_branch` — alphabetically first of the six — and a label named `main`
 * never reaches the root once eight branches match it. Taking one value per
 * dimension per pass means every matching dimension is represented before any
 * dimension takes a second slot, which is the property the cross-dimension
 * type-ahead exists for.
 */
export function rootSuggestions(
  facets: readonly FacetValue[],
  query: string,
  limit = ROOT_VALUE_LIMIT,
): RootSuggestion[] {
  const needle = query.trim().toLowerCase();

  if (!needle) return FILTER_FIELDS.map((d) => ({ kind: 'field' as const, field: d.field }));

  const fieldRank = (d: FilterFieldDescriptor): number => {
    const name = d.label.toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    return Number.POSITIVE_INFINITY;
  };

  const fieldHits: RootSuggestion[] = FILTER_FIELDS
    .map((d) => ({ d, rank: fieldRank(d) }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort((a, b) => a.rank - b.rank)
    .map(({ d }) => ({ kind: 'field' as const, field: d.field }));

  // Bucket the matches per dimension first, preserving catalog order within a
  // dimension, so the round-robin below can interleave them.
  const facetToField = new Map(FILTER_FIELDS.map((d) => [d.facet, d.field]));
  const byField = new Map<FilterField, RootSuggestion[]>();
  for (const f of facets) {
    if (!f.value.toLowerCase().includes(needle)) continue;
    const field = facetToField.get(f.facet);
    if (!field) continue;
    const bucket = byField.get(field);
    const hit: RootSuggestion = { kind: 'value', field, value: f.value, count: f.count };
    if (bucket) bucket.push(hit);
    else byField.set(field, [hit]);
  }

  // One value per dimension per pass, dimensions in menu order, until the cap
  // is reached or every bucket is drained.
  const valueHits: RootSuggestion[] = [];
  const buckets = FILTER_FIELDS.map((d) => byField.get(d.field)).filter(
    (b): b is RootSuggestion[] => b !== undefined,
  );
  for (let round = 0; valueHits.length < limit; round++) {
    let emitted = false;
    for (const bucket of buckets) {
      if (valueHits.length >= limit) break;
      const hit = bucket[round];
      if (!hit) continue;
      valueHits.push(hit);
      emitted = true;
    }
    if (!emitted) break;
  }

  return [...fieldHits, ...valueHits];
}

// ── Wire ─────────────────────────────────────────────────────────────────────

/** The `tags_mode` a label operator maps to. */
function tagsModeFor(operator: FilterOperator): TagsMode {
  if (operator === 'all') return 'all';
  if (operator === 'nin') return 'none';
  return 'any';
}

/** The scalar `*_mode` an operator maps to. `all` is unreachable for a scalar. */
function scalarModeFor(operator: FilterOperator): ScalarFilterMode {
  return operator === 'nin' ? 'nin' : 'in';
}

/**
 * Translate the bar into `GET /memories` query params.
 *
 * The only place the UI vocabulary (`label`, `includes all`) meets the wire
 * vocabulary (`tags`, `tags_mode=all`), so a rename on either side is one edit
 * and a type error rather than a silent mismatch — the return type is
 * `Partial<ListMemoriesQuery>`, which is the schema the handler validates
 * against.
 *
 * Values are comma-joined, matching how `tags` has always been sent. A value
 * containing a comma is therefore unreachable over this transport; that is a
 * property of the wire format (see `parseTagsParam`), not of this function.
 */
export function filtersToQueryParams(
  filters: readonly Filter[],
): Partial<ListMemoriesQuery> {
  const params: Partial<ListMemoriesQuery> = {};

  for (const filter of normalizeFilters(filters as unknown[])) {
    const joined = filter.values.join(',');
    switch (filter.field) {
      case 'label':
        params.tags = joined;
        params.tags_mode = tagsModeFor(filter.operator);
        break;
      case 'agent':
        params.source_agent = joined;
        params.source_agent_mode = scalarModeFor(filter.operator);
        break;
      case 'trigger':
        params.trigger = joined;
        params.trigger_mode = scalarModeFor(filter.operator);
        break;
      // The taxonomy pair. `GET /memories` has accepted these since 00056 and
      // the handler has always filtered on them — the only thing that was
      // missing was a descriptor to turn a pill into the param.
      case 'kind':
        params.kind = joined;
        params.kind_mode = scalarModeFor(filter.operator);
        break;
      case 'host':
        params.host = joined;
        params.host_mode = scalarModeFor(filter.operator);
        break;
      // Ownership (00064). `personal` plus org slugs; the handler resolves the
      // slugs against the caller's member orgs. Same conjunct-of-disjunction
      // shape as the scalar dimensions.
      case 'owner':
        params.owner = joined;
        params.owner_mode = scalarModeFor(filter.operator);
        break;
      case 'repo':
        params.origin_repo = joined;
        params.origin_repo_mode = scalarModeFor(filter.operator);
        break;
      case 'branch':
        params.origin_branch = joined;
        params.origin_branch_mode = scalarModeFor(filter.operator);
        break;
      case 'pr':
        // Digits only: the column is an integer, and a non-numeric value can
        // only have come from a hand-edited URL. Dropping it here means the
        // request never carries a value the handler would drop anyway.
        params.origin_pr = filter.values.filter((v) => /^\d+$/.test(v)).join(',');
        params.origin_pr_mode = scalarModeFor(filter.operator);
        if (!params.origin_pr) {
          delete params.origin_pr;
          delete params.origin_pr_mode;
        }
        break;
    }
  }

  return params;
}

/**
 * The active filters as `GET /memories/facets` drill-down params.
 *
 * The facets route mirrors `GET /memories`' DIMENSION filter params under the
 * same names (`ListFacetsQuerySchema`, migration 00057), so this is exactly
 * {@link filtersToQueryParams} — every key it sets is one the facets route also
 * accepts. Passing them turns the catalog's counts into drill-down figures: the
 * endpoint counts each dimension with every OTHER active filter applied but not
 * its own (self-exclusion, done server-side), so a value's count is what
 * selecting it would actually yield while the dimension you are standing in
 * still shows its alternatives. Absent filters → the global catalog, unchanged.
 *
 * The cast is sound because `filtersToQueryParams` only ever sets dimension
 * keys; the two query types differ only in the NON-dimension keys (`q`, `key`,
 * `sort`, …) it never touches — which the facets route deliberately does not
 * mirror.
 */
export function filtersToFacetParams(filters: readonly Filter[]): Partial<ListFacetsQuery> {
  return filtersToQueryParams(filters) as Partial<ListFacetsQuery>;
}

/**
 * Translate the bar into a `POST /memories/list` BODY.
 *
 * The same seam as {@link filtersToQueryParams}, onto the transport the
 * dashboard actually uses — and the reason there are two. The query form joins
 * a dimension's values into one string, which `ValueListSchema` caps at 2048
 * characters: with production-length host names that is roughly 50-75 values,
 * a different number for every dimension, and past it the route answers 400 and
 * the Explorer shows "Failed to load memories". Nothing guards the URL as a
 * whole either, so eight dimensions individually under the cap still compose a
 * request a gateway rejects without a LoreKit error envelope.
 *
 * Values are NOT joined here, so a value containing a comma survives — which
 * over the query transport is unreachable by construction. The return type is
 * `Partial<ListMemoriesBody>`, the schema the handler validates against, so a
 * contract change is a type error rather than a silent mismatch.
 */
export function filtersToBody(filters: readonly Filter[]): Partial<ListMemoriesBody> {
  const body: Partial<ListMemoriesBody> = {};

  for (const filter of normalizeFilters(filters as unknown[])) {
    const values = [...filter.values];
    switch (filter.field) {
      case 'label':
        body.tags = values;
        body.tags_mode = tagsModeFor(filter.operator);
        break;
      case 'agent':
        body.source_agent = values;
        body.source_agent_mode = scalarModeFor(filter.operator);
        break;
      case 'trigger':
        body.trigger = values;
        body.trigger_mode = scalarModeFor(filter.operator);
        break;
      case 'kind':
        body.kind = values;
        body.kind_mode = scalarModeFor(filter.operator);
        break;
      case 'host':
        body.host = values;
        body.host_mode = scalarModeFor(filter.operator);
        break;
      case 'owner':
        body.owner = values;
        body.owner_mode = scalarModeFor(filter.operator);
        break;
      case 'repo':
        body.origin_repo = values;
        body.origin_repo_mode = scalarModeFor(filter.operator);
        break;
      case 'branch':
        body.origin_branch = values;
        body.origin_branch_mode = scalarModeFor(filter.operator);
        break;
      case 'pr': {
        // Digits only, exactly as the query form does: the column is an integer
        // and a non-numeric value can only have come from a hand-edited URL, so
        // the request never carries one the handler would drop anyway.
        const digits = values.filter((v) => /^\d+$/.test(v));
        if (digits.length > 0) {
          body.origin_pr = digits;
          body.origin_pr_mode = scalarModeFor(filter.operator);
        }
        break;
      }
    }
  }

  return body;
}

/**
 * The active filters as a `POST /memories/facets` drill-down body.
 *
 * The facets route mirrors the list route's dimension fields by name, so this
 * is exactly {@link filtersToBody} — the drill-down (self-exclusion) is
 * entirely the endpoint's job. The cast is sound for {@link filtersToFacetParams}'
 * reason: only dimension keys are ever set, and the two body types differ only
 * in the non-dimension keys this function never touches.
 */
export function filtersToFacetBody(filters: readonly Filter[]): Partial<ListFacetsBody> {
  return filtersToBody(filters) as Partial<ListFacetsBody>;
}

/** The active filters as a `POST /memories/activity` body. Same mapping again. */
export function filtersToActivityBody(filters: readonly Filter[]): Partial<ActivityBody> {
  return filtersToBody(filters) as Partial<ActivityBody>;
}
