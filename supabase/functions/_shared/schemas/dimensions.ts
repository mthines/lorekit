// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/shared/dimensions.ts
// Regenerate: node scripts/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
/**
 * The ONE normalised shape of the memory filter dimensions, and the two
 * decoders that produce it.
 *
 * `GET /memories` and `POST /memories/list` are the same read over two
 * transports: a query string, where each dimension is a comma-joined string
 * capped at 2048 characters, and a JSON body, where it is a real array. The
 * risk in having two is that they drift — one applies `origin_pr`'s digit
 * filter and the other does not, one splits on commas and the other does not —
 * and a drift here is silent, because both answer 200 with plausible rows.
 *
 * So neither handler decides anything. Each converts its own input into
 * `MemoryDimensions` and hands it to the SAME predicate function, which is the
 * only code that knows how a dimension becomes SQL. Adding a dimension is one
 * field here and one line in the predicate, not two of each.
 *
 * `filter.ts`'s reasoning, applied to the decode step: pure, part of the wire
 * contract, needed by more than one runtime (the edge tree has no test
 * harness), so it lives beside the schemas that validate its input.
 */

import { normalizeTagList, parseTagsParam } from './tags.ts';
import type { ScalarFilterMode, TagsMode } from './memory.ts';

/** One dimension: the values it names and how they combine. */
export interface Dimension<Mode> {
  values: string[];
  mode: Mode;
}

/**
 * Every filterable dimension, decoded and normalised.
 *
 * A dimension that names no values is still present with an empty `values`
 * array rather than being absent — the predicate treats empty as "not
 * filtered", so there is exactly one representation of an inactive dimension
 * and no `undefined` to forget to handle.
 */
export interface MemoryDimensions {
  tags: Dimension<TagsMode>;
  source_agent: Dimension<ScalarFilterMode>;
  trigger: Dimension<ScalarFilterMode>;
  kind: Dimension<ScalarFilterMode>;
  host: Dimension<ScalarFilterMode>;
  origin_repo: Dimension<ScalarFilterMode>;
  origin_branch: Dimension<ScalarFilterMode>;
  /** Digits only — see {@link digitsOnly}. */
  origin_pr: Dimension<ScalarFilterMode>;
  owner: Dimension<ScalarFilterMode>;
}

/** The scalar dimension names, in the order the predicate applies them. */
export const SCALAR_DIMENSIONS = [
  'source_agent',
  'trigger',
  'kind',
  'host',
  'origin_repo',
  'origin_branch',
  'origin_pr',
  'owner',
] as const;
export type ScalarDimension = (typeof SCALAR_DIMENSIONS)[number];

/**
 * `origin_pr` is an `integer` column, so a non-numeric entry is DROPPED rather
 * than 400ing the request: the filter bar can be built from a hand-editable
 * URL, and one bad entry should narrow the filter, not break the page. A list
 * that reduces to empty applies no filter at all, like every other dimension.
 *
 * The digit run is BOUNDED to what int4 can hold, and that bound has to live
 * HERE rather than only in SQL, because the three readers disagree about what
 * an over-wide value does. `lorekit_memory_list` (00067) drops it, so the
 * dimension silently widens to unfiltered; `lorekit_memory_facets` and
 * `lorekit_memory_activity` still cast under a bare `^[0-9]+$` and raise
 * `22003`, which surfaces as a 500. Dropping it at the ONE decoder both
 * transports share means no reader ever sees it and the three cannot disagree.
 * `0*` keeps the zero-padded form working (`007` → PR 7), and nine significant
 * digits is the widest run that cannot overflow int4.
 */
function digitsOnly(values: readonly string[]): string[] {
  return values.filter((v) => /^0*\d{1,9}$/.test(v));
}

/** The query-string shape: one comma-joined string per dimension. */
export interface DimensionQueryParams {
  tags?: string | undefined;
  tags_mode?: TagsMode | undefined;
  source_agent?: string | undefined;
  source_agent_mode?: ScalarFilterMode | undefined;
  trigger?: string | undefined;
  trigger_mode?: ScalarFilterMode | undefined;
  kind?: string | undefined;
  kind_mode?: ScalarFilterMode | undefined;
  host?: string | undefined;
  host_mode?: ScalarFilterMode | undefined;
  origin_repo?: string | undefined;
  origin_repo_mode?: ScalarFilterMode | undefined;
  origin_branch?: string | undefined;
  origin_branch_mode?: ScalarFilterMode | undefined;
  origin_pr?: string | undefined;
  origin_pr_mode?: ScalarFilterMode | undefined;
  owner?: string | undefined;
  owner_mode?: ScalarFilterMode | undefined;
}

/** The body shape: a real array per dimension. */
export interface DimensionBodyFields {
  tags?: readonly string[] | undefined;
  tags_mode?: TagsMode | undefined;
  source_agent?: readonly string[] | undefined;
  source_agent_mode?: ScalarFilterMode | undefined;
  trigger?: readonly string[] | undefined;
  trigger_mode?: ScalarFilterMode | undefined;
  kind?: readonly string[] | undefined;
  kind_mode?: ScalarFilterMode | undefined;
  host?: readonly string[] | undefined;
  host_mode?: ScalarFilterMode | undefined;
  origin_repo?: readonly string[] | undefined;
  origin_repo_mode?: ScalarFilterMode | undefined;
  origin_branch?: readonly string[] | undefined;
  origin_branch_mode?: ScalarFilterMode | undefined;
  origin_pr?: readonly string[] | undefined;
  origin_pr_mode?: ScalarFilterMode | undefined;
  owner?: readonly string[] | undefined;
  owner_mode?: ScalarFilterMode | undefined;
}

function build(
  values: (name: keyof MemoryDimensions) => string[],
  params: DimensionQueryParams | DimensionBodyFields,
): MemoryDimensions {
  const scalar = (name: ScalarDimension): Dimension<ScalarFilterMode> => ({
    values: name === 'origin_pr' ? digitsOnly(values(name)) : values(name),
    mode: (params as Record<string, ScalarFilterMode | undefined>)[`${name}_mode`] ?? 'in',
  });
  return {
    tags: { values: values('tags'), mode: params.tags_mode ?? 'any' },
    source_agent: scalar('source_agent'),
    trigger: scalar('trigger'),
    kind: scalar('kind'),
    host: scalar('host'),
    origin_repo: scalar('origin_repo'),
    origin_branch: scalar('origin_branch'),
    origin_pr: scalar('origin_pr'),
    owner: scalar('owner'),
  };
}

/**
 * Decode the `GET` form. Every list-valued param splits by the SAME
 * `parseTagsParam`, which is why a value containing a comma is unreachable over
 * this transport — a property of the wire format, and the reason the body form
 * exists.
 */
export function dimensionsFromQuery(params: DimensionQueryParams): MemoryDimensions {
  return build(
    (name) => parseTagsParam((params as Record<string, string | undefined>)[name]),
    params,
  );
}

/**
 * Decode the `POST` form. `normalizeTagList` applies the same trim / drop-empty
 * / dedupe rule the query path gets from `parseTagsParam`, minus the splitting
 * — so the two decoders differ in exactly one thing, which is the one thing
 * they are supposed to differ in.
 */
export function dimensionsFromBody(body: DimensionBodyFields): MemoryDimensions {
  return build(
    (name) => normalizeTagList((body as Record<string, readonly string[] | undefined>)[name]),
    body,
  );
}
