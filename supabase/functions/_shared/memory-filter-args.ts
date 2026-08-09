/**
 * The ONE translation from a route's dimension-filter query params to the RPC
 * arguments the aggregate functions take.
 *
 * Three routes narrow memories by the same eight dimensions — `GET /memories`
 * (through PostgREST), `GET /memories/facets` and `GET /memories/activity`
 * (both through a plpgsql aggregate). The two aggregate handlers were each
 * going to spell out the same eighteen-key argument object, splitting every
 * value with the same rule and applying the same digits-only filter to
 * `origin_pr`. This is that object, built once.
 *
 * Pure and import-free, so it is mirrored verbatim into
 * `supabase/functions/_shared/memory-filter-args.ts` for the Deno edge tree and
 * drift-guarded by `edge-parity.spec.ts` — the `rest-tool-name.ts` pattern.
 *
 * ## Why the parameter names are the wire names
 *
 * `p_tags`, `p_source_agent_mode`, … are exactly `tags`, `source_agent_mode`
 * with a `p_` prefix, and those in turn are exactly what `GET /memories` calls
 * them. One vocabulary from the query string to the SQL argument means a caller
 * can forward its filter state verbatim and a reader can follow one name all
 * the way down.
 */

/** The dimension-filter query params, as a route hands them over after validation. */
export interface MemoryFilterParams {
  scope?: string | undefined;
  tags?: string | undefined;
  tags_mode?: string | undefined;
  source_agent?: string | undefined;
  source_agent_mode?: string | undefined;
  trigger?: string | undefined;
  trigger_mode?: string | undefined;
  kind?: string | undefined;
  kind_mode?: string | undefined;
  host?: string | undefined;
  host_mode?: string | undefined;
  origin_repo?: string | undefined;
  origin_repo_mode?: string | undefined;
  origin_branch?: string | undefined;
  origin_branch_mode?: string | undefined;
  origin_pr?: string | undefined;
  origin_pr_mode?: string | undefined;
}

/** The `p_*` arguments the aggregate RPCs take for those filters. */
export interface MemoryFilterRpcArgs {
  p_scope: string | null;
  p_tags: string[] | null;
  p_tags_mode: string;
  p_source_agent: string[] | null;
  p_source_agent_mode: string;
  p_trigger: string[] | null;
  p_trigger_mode: string;
  p_kind: string[] | null;
  p_kind_mode: string;
  p_host: string[] | null;
  p_host_mode: string;
  p_origin_repo: string[] | null;
  p_origin_repo_mode: string;
  p_origin_branch: string[] | null;
  p_origin_branch_mode: string;
  p_origin_pr: string[] | null;
  p_origin_pr_mode: string;
}

/**
 * Split a comma-separated value list, or `null` for "not filtered".
 *
 * `null`, never `[]`: an empty array is a filter matching nothing, while every
 * RPC reads NULL as "this dimension is untouched". A param present but empty
 * (`?kind=`) therefore applies no filter rather than emptying the result — the
 * behaviour a hand-edited URL should have.
 *
 * The splitting rule is `parseTagsParam`'s, restated here rather than imported
 * so this module stays import-free and mirrorable: trim, drop empties. The
 * consequence both share is that a value containing a comma is unreachable over
 * these params; `POST /memories/search`'s filter tree is the way to express one.
 */
function list(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return values.length ? values : null;
}

/**
 * `origin_pr` is an INTEGER column, so non-numeric entries are DROPPED here
 * rather than rejected.
 *
 * The list arrives from a hand-editable URL and one bad entry should narrow the
 * filter, not break the page — the documented behaviour of `GET /memories`,
 * which filters the same way before emitting the values unquoted. A list that
 * reduces to empty applies no filter at all, matching every other dimension.
 */
function prList(raw: string | undefined): string[] | null {
  const values = list(raw);
  if (values === null) return null;
  const digits = values.filter((v) => /^\d+$/.test(v));
  return digits.length ? digits : null;
}

/**
 * Build the RPC argument object for a route's dimension filters.
 *
 * Modes are defaulted here as well as in the schema, so a caller that builds
 * params by hand (a test, a future internal caller) cannot produce an argument
 * object the RPC reads differently from the route.
 */
export function memoryFilterRpcArgs(params: MemoryFilterParams): MemoryFilterRpcArgs {
  return {
    p_scope: params.scope ?? null,
    p_tags: list(params.tags),
    p_tags_mode: params.tags_mode ?? 'any',
    p_source_agent: list(params.source_agent),
    p_source_agent_mode: params.source_agent_mode ?? 'in',
    p_trigger: list(params.trigger),
    p_trigger_mode: params.trigger_mode ?? 'in',
    p_kind: list(params.kind),
    p_kind_mode: params.kind_mode ?? 'in',
    p_host: list(params.host),
    p_host_mode: params.host_mode ?? 'in',
    p_origin_repo: list(params.origin_repo),
    p_origin_repo_mode: params.origin_repo_mode ?? 'in',
    p_origin_branch: list(params.origin_branch),
    p_origin_branch_mode: params.origin_branch_mode ?? 'in',
    p_origin_pr: prList(params.origin_pr),
    p_origin_pr_mode: params.origin_pr_mode ?? 'in',
  };
}

/**
 * Whether any dimension filter is actually applied.
 *
 * Lets a caller tell "no filters" from "filters that happen to match
 * everything" — the Explorer uses it to decide whether to tell the reader that
 * its numbers are narrowed.
 */
export function hasMemoryFilters(args: MemoryFilterRpcArgs): boolean {
  return (
    args.p_scope !== null ||
    args.p_tags !== null ||
    args.p_source_agent !== null ||
    args.p_trigger !== null ||
    args.p_kind !== null ||
    args.p_host !== null ||
    args.p_origin_repo !== null ||
    args.p_origin_branch !== null ||
    args.p_origin_pr !== null
  );
}
