/**
 * The five retention thresholds, and the ONE place they become RPC parameters.
 *
 * They are the conditions a retention policy is written in — "older than N
 * days", "unopened for N days", "written at most N times", "delivered at most N
 * times", "chosen at most N times" — and they arrive on four routes:
 * `GET`/`POST /memories` (the rows) and `GET`/`POST` `/facets`, `/activity`,
 * `/pivot` (the numbers describing those rows).
 *
 * Before migration 00108 only the list applied them, so setting
 * `max_opened_count` narrowed the Explorer's rows and left its facet counts,
 * its stat cards and its matrix counting the un-narrowed population — every
 * number on the page describing a different set from the one below it. 00108
 * fixed the SQL side by giving the four readers ONE shared predicate
 * (`lorekit_match_retention`) instead of a fourth inline copy. This module is
 * the same fix one layer up: four handlers, one mapping from the decoded
 * request to the `p_*` arguments, so a route cannot be given the parameter and
 * then forget to forward it.
 *
 * They are deliberately NOT part of `MemoryDimensions` (see the header of
 * `_shared/schemas/dimensions.ts`): a dimension is a set of enumerable values,
 * and a threshold is a comparison against a number with no value catalog to
 * enumerate. It can narrow a facet count; it can never BE one.
 *
 * Both transports feed this the same way, because both schemas carry the same
 * five field names — the query forms coerce a numeric string, the body forms
 * require a real number, and by the time either reaches here it is a `number`
 * or absent.
 */

/**
 * The thresholds as a handler holds them: plain optional scalars, exactly the
 * shape `list.ts`'s `ListParams` already used.
 */
export interface RetentionConditions {
  min_age_days?: number | undefined;
  unseen_days?: number | undefined;
  max_seen_count?: number | undefined;
  max_read_count?: number | undefined;
  max_opened_count?: number | undefined;
}

/**
 * Pick the five thresholds off a validated query or body.
 *
 * Written as an explicit field list rather than a spread of the whole input:
 * these objects also carry `scope`, `limit`, the nine dimensions and (on the
 * list) a cursor, none of which belong in an RPC's retention arguments. Naming
 * them is also what makes a schema that stops carrying one a TYPE error here
 * instead of a silently-dropped filter.
 */
export function retentionFrom(input: RetentionConditions): RetentionConditions {
  return {
    min_age_days: input.min_age_days,
    unseen_days: input.unseen_days,
    max_seen_count: input.max_seen_count,
    max_read_count: input.max_read_count,
    max_opened_count: input.max_opened_count,
  };
}

/**
 * The `p_*` arguments for `lorekit_memory_list` / `_facets` / `_activity` /
 * `_pivot`. All four take the same five parameter names, which is what lets one
 * function serve them.
 *
 * `?? null` is load-bearing rather than defensive: the SQL reads a null
 * threshold as "not filtered", and `undefined` does not survive JSON
 * serialisation as a named argument — PostgREST would receive an object with
 * the key absent, which for a parameter that has a default is the same thing,
 * but for one that does not would be a missing-argument error. Being explicit
 * keeps the call site independent of which parameters happen to have defaults.
 *
 * Note there is no `0`-to-null coalescing anywhere here, and there must not be:
 * `max_opened_count => 0` is the whole point of migration 00105 ("nothing ever
 * chose this lesson") and `max_seen_count => 0` / `max_read_count => 0` are
 * legal too. A truthiness check instead of a null check would silently turn the
 * most useful threshold in the set into no filter at all.
 */
export function retentionRpcParams(r: RetentionConditions): {
  p_min_age_days: number | null;
  p_unseen_days: number | null;
  p_max_seen_count: number | null;
  p_max_read_count: number | null;
  p_max_opened_count: number | null;
} {
  return {
    p_min_age_days: r.min_age_days ?? null,
    p_unseen_days: r.unseen_days ?? null,
    p_max_seen_count: r.max_seen_count ?? null,
    p_max_read_count: r.max_read_count ?? null,
    p_max_opened_count: r.max_opened_count ?? null,
  };
}
