/**
 * The Lore Explorer's retention-preview conditions.
 *
 * A saved retention policy (`@lorekit/schemas/retention`, `GroomConditionsSchema`)
 * matches on five optional thresholds — `min_age_days`, `unseen_days`,
 * `max_seen_count`, `max_read_count`, `max_opened_count` — and until now the ONLY place you could see what those
 * conditions would catch was the Settings → Retention Policies dialog's live
 * preview, which answers with a bare count, not the lesson cards themselves.
 *
 * This module is the same set, modelled as an Explorer filter: set on the
 * list alongside the filter bar's dimensions, so the list you are already
 * looking at narrows to exactly what a policy with these conditions would
 * archive — "verify before you run it" without leaving the page. It composes
 * with `lib/filters.ts`'s `Filter[]` bar rather than becoming a tenth entry in
 * it, because it is not a categorical dimension: there is no facet catalog of
 * "ages", so the value space is a raw number a user types, not a value picked
 * from a list.
 *
 * Kept dependency-free and pure, in `lib/filters.ts`'s tradition — every
 * decision here is unit-tested without a browser, and the impure shell is
 * `components/lore/RetentionConditionsControl.tsx`.
 */

import type { GroomConditions, GroomDimensionFilters } from '@lorekit/schemas/retention';
import type {
  ListFacetsBody,
  ListMemoriesBody,
  ScalarFilterMode,
  TagsMode,
} from '@lorekit/schemas/memory';
import { filtersToBody, normalizeFilters, type Filter, type FilterField, type FilterOperator } from './filters';

/** The five conditions, camelCased for the UI's own state — see `GroomConditions` for the wire shape. */
export interface RetentionConditions {
  minAgeDays?: number;
  unseenDays?: number;
  maxSeenCount?: number;
  /**
   * Reads, not writes — `max_read_count` (00101). EVERY read counts, including
   * the bulk list/search ride-alongs, so this is a COST threshold: "delivered
   * into a context at most N times". It scales with how many scopes a lesson
   * sits under, not with how useful it is.
   */
  maxReadCount?: number;
  /**
   * Deliberate fetches only — `max_opened_count` (00105). A targeted
   * `memory.read` from an agent (`mcp`/`cli`), never a list/search ride-along,
   * so this is an UPTAKE threshold: `0` means "nothing ever chose to open it".
   * That is the condition `max_read_count` could never express — see the
   * migration header for the measured dead zone that motivated it.
   */
  maxOpenedCount?: number;
}

/**
 * The bounds each condition accepts — mirrors `GroomConditionsSchema` exactly.
 * Exported so the impure shell (`RetentionConditionsControl`) can enforce the
 * SAME per-field range while the user is typing, rather than re-deriving it
 * and drifting from what `normalizeRetentionConditions` accepts.
 */
export const RETENTION_CONDITION_BOUNDS = {
  minAgeDays: { min: 1, max: 3650 },
  unseenDays: { min: 1, max: 3650 },
  maxSeenCount: { min: 0, max: 100_000 },
  maxReadCount: { min: 0, max: 100_000 },
  maxOpenedCount: { min: 0, max: 100_000 },
} as const;

/** An empty condition set — nothing narrowed. Module-scoped for reference stability. */
export const NO_RETENTION_CONDITIONS: RetentionConditions = {};

/**
 * Example values shown as INPUT PLACEHOLDERS, never applied as a filter on
 * their own — a blank field still means "not narrowed" (see
 * {@link normalizeRetentionConditions}). They exist purely so a reader who has
 * never used the fields sees a concrete, sensible example of what to
 * type rather than an unlabelled blank box: a week-old lesson nobody has
 * opened in three months and has recurred at most once is the shape of lore
 * this feature is typically built to catch.
 *
 * `maxReadCount`'s example is 200, not 0, because 0 is a value it can never
 * usefully take. Measured against the live store: `max_read_count <= 5`
 * matched nothing at all, the first non-empty result appeared at 26, and 400
 * matched essentially everything — a lesson that has been paged over by any
 * `memory.list` already carries a read count in the hundreds. Suggesting 0
 * handed the reader a filter that silently returns nothing and reads as a
 * broken feature. `maxOpenedCount` keeps 0, because there 0 is the whole
 * point: "nothing has ever deliberately fetched this."
 *
 * Render them through {@link retentionConditionPlaceholder}, never as a bare
 * number — see that function for why.
 */
export const RETENTION_CONDITION_PLACEHOLDERS = {
  minAgeDays: 7,
  unseenDays: 90,
  maxSeenCount: 1,
  maxReadCount: 200,
  maxOpenedCount: 0,
} as const;

/**
 * The placeholder TEXT for one condition input — `e.g. 7`, never a bare `7`.
 *
 * A bare number in a number input is indistinguishable from a typed value at a
 * glance: the only difference is the placeholder's tertiary text colour, which
 * on a phone reads as "a value, slightly dimmer". Two of these fields left
 * blank alongside one that was filled in were reported as all three being
 * active, and the resulting list looked like the filter was broken. `e.g. `
 * cannot be misread as a value, and still shows the reader what to type.
 */
export function retentionConditionPlaceholder(field: keyof RetentionConditions): string {
  return `e.g. ${RETENTION_CONDITION_PLACEHOLDERS[field]}`;
}

/**
 * Parse one field: an in-bounds integer, or `undefined` for anything else — never `NaN`
 * out. Exported so the control's own per-keystroke `setField` enforces the exact same
 * range this module's `normalizeRetentionConditions` does, rather than a looser
 * `n >= 0` check that silently reverts an out-of-range value on the next render.
 */
export function parseCondition(raw: unknown, bounds: { min: number; max: number }): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) return undefined;
  return n;
}

/**
 * Coerce an arbitrary value — a `?retention=` param a user hand-edited, a
 * stale link — into a usable condition set. Total: anything out of bounds or
 * the wrong shape is dropped rather than thrown, matching `normalizeFilters`.
 */
export function normalizeRetentionConditions(raw: unknown): RetentionConditions {
  if (!raw || typeof raw !== 'object') return {};
  const { minAgeDays, unseenDays, maxSeenCount, maxReadCount, maxOpenedCount } = raw as Record<
    string,
    unknown
  >;

  const out: RetentionConditions = {};
  const min = parseCondition(minAgeDays, RETENTION_CONDITION_BOUNDS.minAgeDays);
  if (min !== undefined) out.minAgeDays = min;
  const unseen = parseCondition(unseenDays, RETENTION_CONDITION_BOUNDS.unseenDays);
  if (unseen !== undefined) out.unseenDays = unseen;
  const maxSeen = parseCondition(maxSeenCount, RETENTION_CONDITION_BOUNDS.maxSeenCount);
  if (maxSeen !== undefined) out.maxSeenCount = maxSeen;
  const maxRead = parseCondition(maxReadCount, RETENTION_CONDITION_BOUNDS.maxReadCount);
  if (maxRead !== undefined) out.maxReadCount = maxRead;
  const maxOpened = parseCondition(maxOpenedCount, RETENTION_CONDITION_BOUNDS.maxOpenedCount);
  if (maxOpened !== undefined) out.maxOpenedCount = maxOpened;
  return out;
}

/** Whether any condition is set — what gates the "Create retention policy" action. */
export function hasRetentionConditions(conditions: RetentionConditions): boolean {
  return (
    conditions.minAgeDays !== undefined ||
    conditions.unseenDays !== undefined ||
    conditions.maxSeenCount !== undefined ||
    conditions.maxReadCount !== undefined ||
    conditions.maxOpenedCount !== undefined
  );
}

/** How many conditions are set — the control's count badge. */
export function retentionConditionsCount(conditions: RetentionConditions): number {
  return [
    conditions.minAgeDays,
    conditions.unseenDays,
    conditions.maxSeenCount,
    conditions.maxReadCount,
    conditions.maxOpenedCount,
  ].filter((v) => v !== undefined).length;
}

/**
 * What to persist to `?retention=` — `null` meaning "drop the param". Unlike
 * `filtersParamValue` there is no legacy shorthand to protect: this param is
 * new, so "empty" and "absent" are the same state and both drop it.
 */
export function retentionConditionsParamValue(
  next: RetentionConditions,
): RetentionConditions | null {
  return hasRetentionConditions(next) ? next : null;
}

/**
 * Translate into the `POST /memories/list` body fields (migration 00092) —
 * the same field names `GroomConditionsSchema` uses, so a rename on
 * either side is a type error here rather than a silent mismatch.
 */
export function retentionConditionsToListBody(
  conditions: RetentionConditions,
): Pick<
  ListMemoriesBody,
  'min_age_days' | 'unseen_days' | 'max_seen_count' | 'max_read_count' | 'max_opened_count'
> {
  return {
    ...(conditions.minAgeDays !== undefined ? { min_age_days: conditions.minAgeDays } : {}),
    ...(conditions.unseenDays !== undefined ? { unseen_days: conditions.unseenDays } : {}),
    ...(conditions.maxSeenCount !== undefined ? { max_seen_count: conditions.maxSeenCount } : {}),
    ...(conditions.maxReadCount !== undefined ? { max_read_count: conditions.maxReadCount } : {}),
    ...(conditions.maxOpenedCount !== undefined ? { max_opened_count: conditions.maxOpenedCount } : {}),
  };
}

/**
 * The same five fields, for the three AGGREGATE routes — `/facets`,
 * `/activity`, `/pivot` (migration 00108).
 *
 * Delegates to {@link retentionConditionsToListBody} because the field names
 * are identical on all four bodies by construction: the schemas share one
 * `retentionConditionBodyFields` spread. It exists as its own export anyway,
 * typed against `ListFacetsBody`, so that a schema which stops carrying one of
 * the five becomes a TYPE ERROR here rather than a threshold the aggregate
 * silently ignores — which is precisely the bug 00108 fixed, where the list
 * narrowed and every number describing it did not.
 *
 * Callers spread this alongside `filtersToFacetBody` / `filtersToActivityBody`
 * / `filtersToPivotBody`; the dimensions and the thresholds are independent
 * halves of one request and neither is derivable from the other.
 */
export function retentionConditionsToAggregateBody(
  conditions: RetentionConditions,
): Pick<
  ListFacetsBody,
  'min_age_days' | 'unseen_days' | 'max_seen_count' | 'max_read_count' | 'max_opened_count'
> {
  return retentionConditionsToListBody(conditions);
}

/**
 * Translate into the `GroomConditions` a policy carries — the seam this whole
 * feature exists for: "create a retention policy from these filters" is
 * exactly handing this struct (plus a scope) to `policy.create`.
 */
export function retentionConditionsToGroomConditions(
  conditions: RetentionConditions,
): GroomConditions {
  return retentionConditionsToListBody(conditions);
}

// ── Dimension filters ────────────────────────────────────────────────────────
//
// A retention policy can ALSO carry the same eight dimension filters the
// Explorer's filter bar offers (migration 00093) — label/agent/trigger/kind/
// host/repo/branch/PR, everything `lib/filters.ts`'s `Filter[]` bar holds
// EXCEPT `owner`: a policy's `scope` already partitions personal-vs-org lore
// (v1 is personal-owned only), so a second ownership predicate would either
// agree with the scope or silently fight it — an `owner` filter present on
// the bar is therefore dropped, not carried over, when a policy is created
// from a filtered Explorer view.
//
// The two functions below are the seam: `filtersToGroomDimensionFilters` is
// what "Create retention policy" (the Explorer → Settings handoff) uses to
// carry the CURRENT bar into a new policy's conditions; `groomConditionsToFilters`
// is the reverse, rendering a SAVED policy's stored filters back as `Filter[]`
// pills for `GroomingRuleBuilder`'s edit form — reusing the exact same
// `FilterMenu`/`FilterPill` components the Explorer uses, so "the filter
// that's also getting used for the policy" is the SAME control, not a
// second one that could drift.

/**
 * The dimension-filter fields a policy's conditions carry — `GroomConditions`
 * minus the four age/activity thresholds. An alias of `@lorekit/schemas/retention`'s
 * own `GroomDimensionFilters` (not a hand-written duplicate): its `*_mode`
 * fields are `.optional()` with NO zod `.default(...)` specifically so this
 * stays genuinely optional (`T | undefined`) rather than "always present, the
 * default" — see that schema's own doc for why a `.default()` would break
 * every caller here that builds one of these incrementally.
 */
export type GroomDimensionConditions = GroomDimensionFilters;

/**
 * Translate the Explorer's filter bar into the dimension-filter fields a
 * policy's conditions carry. Reuses `filtersToBody` — the wire shape is
 * IDENTICAL (same field names, same `TagsMode`/`ScalarFilterMode`
 * semantics) — so the two cannot drift on what a filter means; the `owner`
 * dimension `filtersToBody` may also emit is dropped here, per the header.
 */
export function filtersToGroomDimensionFilters(filters: readonly Filter[]): GroomDimensionConditions {
  const body = filtersToBody(filters);
  return {
    tags: body.tags,
    tags_mode: body.tags_mode,
    source_agent: body.source_agent,
    source_agent_mode: body.source_agent_mode,
    trigger: body.trigger,
    trigger_mode: body.trigger_mode,
    kind: body.kind,
    kind_mode: body.kind_mode,
    host: body.host,
    host_mode: body.host_mode,
    origin_repo: body.origin_repo,
    origin_repo_mode: body.origin_repo_mode,
    origin_branch: body.origin_branch,
    origin_branch_mode: body.origin_branch_mode,
    origin_pr: body.origin_pr,
    origin_pr_mode: body.origin_pr_mode,
  };
}

/** A saved policy's (or a `GroomConditions` request's) dimension-filter fields — nullable OR undefined, either transport's shape. */
export interface DimensionFilterSource {
  tags?: string[] | null;
  tags_mode?: TagsMode | null;
  source_agent?: string[] | null;
  source_agent_mode?: ScalarFilterMode | null;
  trigger?: string[] | null;
  trigger_mode?: ScalarFilterMode | null;
  kind?: string[] | null;
  kind_mode?: ScalarFilterMode | null;
  host?: string[] | null;
  host_mode?: ScalarFilterMode | null;
  origin_repo?: string[] | null;
  origin_repo_mode?: ScalarFilterMode | null;
  origin_branch?: string[] | null;
  origin_branch_mode?: ScalarFilterMode | null;
  origin_pr?: string[] | null;
  origin_pr_mode?: ScalarFilterMode | null;
}

/**
 * The reverse of {@link filtersToGroomDimensionFilters}: a saved policy's
 * dimension filters, rendered back as `Filter[]` pills for the edit form.
 * `*_mode` values outside the field's legal operator set (a hand-edited API
 * call, a future mode this UI does not know yet) degrade to the field's
 * default rather than throwing — `normalizeFilters` already establishes that
 * rule for every other source of `Filter[]`, and this is one more.
 */
export function groomConditionsToFilters(source: DimensionFilterSource): Filter[] {
  const raw: { field: FilterField; operator: FilterOperator; values: string[] }[] = [];

  if (source.tags?.length) {
    const operator: FilterOperator =
      source.tags_mode === 'all' ? 'all' : source.tags_mode === 'none' ? 'nin' : 'in';
    raw.push({ field: 'label', operator, values: source.tags });
  }
  if (source.source_agent?.length) {
    raw.push({ field: 'agent', operator: source.source_agent_mode === 'nin' ? 'nin' : 'in', values: source.source_agent });
  }
  if (source.trigger?.length) {
    raw.push({ field: 'trigger', operator: source.trigger_mode === 'nin' ? 'nin' : 'in', values: source.trigger });
  }
  if (source.kind?.length) {
    raw.push({ field: 'kind', operator: source.kind_mode === 'nin' ? 'nin' : 'in', values: source.kind });
  }
  if (source.host?.length) {
    raw.push({ field: 'host', operator: source.host_mode === 'nin' ? 'nin' : 'in', values: source.host });
  }
  if (source.origin_repo?.length) {
    raw.push({ field: 'repo', operator: source.origin_repo_mode === 'nin' ? 'nin' : 'in', values: source.origin_repo });
  }
  if (source.origin_branch?.length) {
    raw.push({ field: 'branch', operator: source.origin_branch_mode === 'nin' ? 'nin' : 'in', values: source.origin_branch });
  }
  if (source.origin_pr?.length) {
    raw.push({ field: 'pr', operator: source.origin_pr_mode === 'nin' ? 'nin' : 'in', values: source.origin_pr });
  }

  return normalizeFilters(raw);
}

/** One phrase describing the active conditions, for the control's trigger label and pill. */
export function retentionConditionsPhrase(conditions: RetentionConditions): string {
  const parts: string[] = [];
  // Vocabulary matches the lesson detail sheet's metadata rows — "Created",
  // "Last agent open", "Recurrence" — so a reader can open any row the filter
  // returned and check the claim against the same words. "unopened" rather
  // than the older "unseen": nothing in the product calls a read "seeing", and
  // the pill was the phrase people quoted back when the condition did not
  // match what they saw on the lesson.
  //
  // One word per counter, and never "seen" for any of them: `written` counts
  // writes, `delivered` counts every read (including the bulk ride-alongs),
  // and `chosen` counts only the deliberate fetches. They sit next to each
  // other in the phrase, so the words have to say which direction each one
  // measures — the older `seen ≤ N×` gave the WRITE counter the one word a
  // reader would naturally attach to a read, and the older `read ≤ N×` did not
  // distinguish "was handed to an agent" from "an agent went and got it".
  if (conditions.minAgeDays !== undefined) parts.push(`created >${conditions.minAgeDays}d ago`);
  if (conditions.unseenDays !== undefined) parts.push(`unopened >${conditions.unseenDays}d`);
  if (conditions.maxSeenCount !== undefined) parts.push(`written ≤ ${conditions.maxSeenCount}×`);
  if (conditions.maxReadCount !== undefined) parts.push(`delivered ≤ ${conditions.maxReadCount}×`);
  // "chosen", the same word the lesson card's utility chip and the detail
  // sheet's Chosen row use for `opened_count`, so the filter and the row it
  // returns describe the counter identically.
  if (conditions.maxOpenedCount !== undefined) parts.push(`chosen ≤ ${conditions.maxOpenedCount}×`);
  return parts.length > 0 ? parts.join(' · ') : 'Age & activity';
}
