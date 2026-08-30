/**
 * The Lore Explorer's retention-preview conditions.
 *
 * A saved retention policy (`@lorekit/schemas/retention`, `GroomConditionsSchema`)
 * matches on three optional thresholds — `min_age_days`, `unseen_days`,
 * `max_seen_count` — and until now the ONLY place you could see what those
 * conditions would catch was the Settings → Retention Policies dialog's live
 * preview, which answers with a bare count, not the lesson cards themselves.
 *
 * This module is the same trio, modelled as an Explorer filter: set on the
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

import type { GroomConditions } from '@lorekit/schemas/retention';
import type { ListMemoriesBody } from '@lorekit/schemas/memory';

/** The three conditions, camelCased for the UI's own state — see `GroomConditions` for the wire shape. */
export interface RetentionConditions {
  minAgeDays?: number;
  unseenDays?: number;
  maxSeenCount?: number;
}

/** The bounds each condition accepts — mirrors `GroomConditionsSchema` exactly. */
const BOUNDS = {
  minAgeDays: { min: 1, max: 3650 },
  unseenDays: { min: 1, max: 3650 },
  maxSeenCount: { min: 0, max: 100_000 },
} as const;

/** An empty condition set — nothing narrowed. Module-scoped for reference stability. */
export const NO_RETENTION_CONDITIONS: RetentionConditions = {};

/** Parse one field: an in-bounds integer, or `undefined` for anything else — never `NaN` out. */
function parseCondition(raw: unknown, bounds: { min: number; max: number }): number | undefined {
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
  const { minAgeDays, unseenDays, maxSeenCount } = raw as Record<string, unknown>;

  const out: RetentionConditions = {};
  const min = parseCondition(minAgeDays, BOUNDS.minAgeDays);
  if (min !== undefined) out.minAgeDays = min;
  const unseen = parseCondition(unseenDays, BOUNDS.unseenDays);
  if (unseen !== undefined) out.unseenDays = unseen;
  const maxSeen = parseCondition(maxSeenCount, BOUNDS.maxSeenCount);
  if (maxSeen !== undefined) out.maxSeenCount = maxSeen;
  return out;
}

/** Whether any condition is set — what gates the "Create retention policy" action. */
export function hasRetentionConditions(conditions: RetentionConditions): boolean {
  return (
    conditions.minAgeDays !== undefined ||
    conditions.unseenDays !== undefined ||
    conditions.maxSeenCount !== undefined
  );
}

/** How many conditions are set — the control's count badge. */
export function retentionConditionsCount(conditions: RetentionConditions): number {
  return [conditions.minAgeDays, conditions.unseenDays, conditions.maxSeenCount].filter(
    (v) => v !== undefined,
  ).length;
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
 * Translate into the `POST /memories/list` body fields (migration 00090) —
 * the same three field names `GroomConditionsSchema` uses, so a rename on
 * either side is a type error here rather than a silent mismatch.
 */
export function retentionConditionsToListBody(
  conditions: RetentionConditions,
): Pick<ListMemoriesBody, 'min_age_days' | 'unseen_days' | 'max_seen_count'> {
  return {
    ...(conditions.minAgeDays !== undefined ? { min_age_days: conditions.minAgeDays } : {}),
    ...(conditions.unseenDays !== undefined ? { unseen_days: conditions.unseenDays } : {}),
    ...(conditions.maxSeenCount !== undefined ? { max_seen_count: conditions.maxSeenCount } : {}),
  };
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

/** One phrase describing the active conditions, for the control's trigger label and pill. */
export function retentionConditionsPhrase(conditions: RetentionConditions): string {
  const parts: string[] = [];
  if (conditions.minAgeDays !== undefined) parts.push(`older than ${conditions.minAgeDays}d`);
  if (conditions.unseenDays !== undefined) parts.push(`unseen ${conditions.unseenDays}d`);
  if (conditions.maxSeenCount !== undefined) parts.push(`seen ≤ ${conditions.maxSeenCount}`);
  return parts.length > 0 ? parts.join(' · ') : 'Age & activity';
}
