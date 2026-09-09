/**
 * Pure logic for applying a filter from inside the memory detail panel (R3).
 *
 * The panel (`LessonDetailSheet.tsx`) is rendered globally by
 * `MemorySidebarProvider` — it has no access to the Lore Explorer's `filters`
 * state, and does not need it: filter state already lives in the URL
 * (`?filters=` / `?scope=`), so applying one from the panel is just a
 * navigation. This module is the pure half of that navigation: given the
 * current URL params and a target, it computes the next URL string. The
 * impure shell (reading `useSearchParams`, calling `router.push`) stays in
 * the component.
 *
 * Deliberately delegates to `filters.ts` rather than re-deriving any of its
 * logic (code-quality: one source of truth) — `toggleFilterValue`,
 * `resolveFilters`, and `filtersParamValue` are the SAME functions the
 * Explorer's own filter bar uses, so a value toggled from the panel produces
 * the exact `?filters=` shape the bar would have written itself.
 */

import {
  filtersParamValue,
  requireField,
  toggleFilterValue,
  type Filter,
  type FilterField,
} from './filters';
import type { LessonEntry } from '@/components/lore/LessonCard';

// ── Model ────────────────────────────────────────────────────────────────────

/** Toggle a value into/out of the unified `?filters=` bar. */
export interface FilterTarget {
  kind: 'filter';
  field: FilterField;
  value: string;
  /** What the affordance's accessible name/tooltip should say, e.g. `Filter by label "perf"`. */
  label: string;
}

/** Set `?scope=` to the memory's own scope — a different mechanism from `?filters=`. */
export interface ScopeTarget {
  kind: 'scope';
  scope: string;
  label: string;
}

export type MetadataFilterTarget = FilterTarget | ScopeTarget;

// ── Per-field targets ────────────────────────────────────────────────────────

/**
 * The `LessonEntry` field each filterable dimension reads, and how to turn
 * its stored value into the string {@link toggleFilterValue} expects.
 *
 * ONE record keyed by `FilterField` (Decision D2 / the plan's code-quality
 * fold-in) rather than a parallel switch statement, so adding a tenth
 * filterable dimension to the panel is one entry here, not a second place
 * that can drift from the first. `origin_pr` is the one field that needs a
 * numeric-to-string conversion; every other accessor already returns the
 * string `toggleFilterValue` stores.
 *
 * Only the dimensions the panel actually shows a value for are listed — see
 * `metadataFilterTargets` for the recurrence/key exclusion (Decision D2/AC-9).
 */
const METADATA_FIELD_SOURCES: Partial<
  Record<FilterField, (lesson: LessonEntry) => string | null | undefined>
> = {
  kind: (lesson) => lesson.kind,
  host: (lesson) => lesson.host,
  agent: (lesson) => lesson.source_agent,
  trigger: (lesson) => lesson.trigger,
  repo: (lesson) => lesson.origin_repo,
  branch: (lesson) => lesson.origin_branch,
  pr: (lesson) => (lesson.origin_pr != null ? String(lesson.origin_pr) : null),
};

/**
 * The applicable filter/scope targets for a lesson's metadata — only the
 * fields that actually have a value on this lesson produce a target, so the
 * caller never has to render (and disable) an affordance for an absent field.
 *
 * `label` (tags) can produce several targets, one per tag — a lesson may
 * carry many labels, unlike every other dimension here, which is scalar.
 * The scope target is always last and always present (every memory has a
 * scope), covering both the header's scope chip and the metadata "Repo" row
 * that links the scope-derived repository — the panel renders the SAME
 * target from either affordance, since both mean "narrow to this scope"
 * (Decision D2).
 *
 * Recurrence (`seen_count`) and the lesson key deliberately produce NO
 * target: recurrence has only a flagged max-threshold (not a clean equals
 * dimension) and the key is search-only — see Decision D2 / AC-9.
 */
export function metadataFilterTargets(lesson: LessonEntry): MetadataFilterTarget[] {
  const targets: MetadataFilterTarget[] = [];

  for (const tag of lesson.tags ?? []) {
    targets.push({
      kind: 'filter',
      field: 'label',
      value: tag,
      label: `Filter by label "${tag}"`,
    });
  }

  for (const [field, read] of Object.entries(METADATA_FIELD_SOURCES) as Array<
    [FilterField, (lesson: LessonEntry) => string | null | undefined]
  >) {
    const value = read(lesson);
    if (!value) continue;
    const { label: fieldLabel, format } = requireField(field);
    targets.push({
      kind: 'filter',
      field,
      value,
      label: `Filter by ${fieldLabel.toLowerCase()} ${format(value)}`,
    });
  }

  targets.push({
    kind: 'scope',
    scope: lesson.scope,
    label: `Filter by scope ${lesson.scope}`,
  });

  return targets;
}

// ── URL computation ──────────────────────────────────────────────────────────

/** The subset of the Explorer's URL state a metadata-filter apply needs to read. */
export interface CurrentExplorerParams {
  /** The current `?filters=` value, already resolved to a `Filter[]` (e.g. via `resolveFilters`). */
  filters: Filter[];
  /**
   * The current `?scope=` value, ALREADY DESERIALISED (the bare scope
   * string, e.g. `project::acme`), or `null` for "all scopes". `useUrlState`
   * JSON-encodes every param it writes (`serialise`/`deserialise` in
   * `lib/hooks/useUrlState.ts`) — including a plain string, which is why the
   * Explorer's own `?scope=` reads as a QUOTED JSON string on the wire
   * (`?scope=%22project%3A%3Aacme%22`). This function re-encodes it the same
   * way when writing, so the caller passes the bare value it already has.
   */
  scope: string | null;
  /**
   * The current `?lesson=` value (the open panel's raw, already-decoded
   * param string — JSON-encoded `{scope,key}` or a bare id), preserved
   * across the apply — Decision D3.
   */
  lesson: string | null;
  /**
   * The current `?memoryId=` value, if the panel was opened via that
   * deep-link form instead of `?lesson=`. Preserved for the same reason —
   * a full navigation replaces the whole query string, so an unforwarded
   * `memoryId` would silently close a panel opened that way.
   */
  memoryId?: string | null;
  /** Legacy shorthands, forwarded to {@link filtersParamValue} unchanged. */
  legacyTags?: unknown;
  legacyOwner?: unknown;
}

/**
 * The next `/lore?…` href for applying `target` from the panel.
 *
 * A `filter` target toggles the value into the SAME `Filter[]` shape the
 * Explorer's filter bar writes (`toggleFilterValue` + `filtersParamValue` —
 * no new URL param, AC-6); a `scope` target replaces `?scope=` instead
 * (AC-7). Either way `?lesson=` is preserved when present, so the panel
 * stays open on the SAME memory after the navigation (Decision D3/AC-8) even
 * if that memory no longer matches the newly-narrowed list.
 */
export function applyMetadataFilterHref(
  current: CurrentExplorerParams,
  target: MetadataFilterTarget,
): string {
  const params = new URLSearchParams();

  if (target.kind === 'scope') {
    // `useUrlState`'s wire format — see the field docblock above.
    params.set('scope', JSON.stringify(target.scope));
    const filtersValue = filtersParamValue(current.filters, current.legacyTags, current.legacyOwner);
    if (filtersValue !== null) params.set('filters', JSON.stringify(filtersValue));
  } else {
    const nextFilters = toggleFilterValue(current.filters, target.field, target.value);
    const filtersValue = filtersParamValue(nextFilters, current.legacyTags, current.legacyOwner);
    if (filtersValue !== null) params.set('filters', JSON.stringify(filtersValue));
    if (current.scope !== null) params.set('scope', JSON.stringify(current.scope));
  }

  if (current.lesson !== null) params.set('lesson', current.lesson);
  if (current.memoryId) params.set('memoryId', current.memoryId);

  const qs = params.toString();
  return qs ? `/lore?${qs}` : '/lore';
}
