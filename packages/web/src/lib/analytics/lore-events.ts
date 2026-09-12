/**
 * lore-events — the bounded vocabularies and pure derivations behind the
 * Explorer's and Insights' product events.
 *
 * ## Why this is a module and not inline ternaries
 *
 * Every attribute these events carry has to be BOUNDED and free of user
 * content, for the reason `analytics/track.ts` states: a lesson key, a scope
 * string, a label value or a search term is user-authored and unbounded, so
 * sending one leaks content AND explodes the attribute's cardinality in Dash0.
 *
 * The Explorer is the one surface where almost everything a reader touches IS
 * user content — they pick a scope, a label, a host, a memory. So the mapping
 * from "what was clicked" to "what may be recorded" is the load-bearing part of
 * instrumenting this page, and it lives here as pure functions with a
 * co-located spec rather than as a ternary at each of the ~30 call sites. That
 * is the repo's functional-core convention (`button-styles.ts`,
 * `filters.ts`, `explorer-instruments.ts`) applied to telemetry.
 *
 * ## The rule each derivation holds
 *
 * - A scope becomes its TYPE (`repo`/`project`/`branch`/`global`) — four values,
 *   never the `mthines/lorekit` half that names someone's repository.
 * - A filter becomes its FIELD and OPERATOR — `label`/`host`/`in`/`nin`, never
 *   the values, which are the user's own labels and hostnames.
 * - A search becomes its LENGTH — never the query.
 * - A cluster becomes a SIZE BUCKET — a raw member count is a fingerprint of a
 *   specific cluster once it gets large.
 * - A time range becomes a preset name plus a numeric span — `span_days` is a
 *   MEASURE (it gets averaged and percentiled), not a dimension.
 *
 * Everything else in these events is a closed union declared below, so a new
 * value costs a type error rather than arriving silently in production.
 */

import {
  RETENTION_FIELDS,
  type RetentionConditions,
  type RetentionField,
} from '@/lib/retention-filter';
import { scopeType, type ScopePrefix } from '@/lib/scope';
import { DAY_MS, isPresetRange, resolveRange, type RangePreset, type TimeRange } from '@/lib/time-range';

// ── Bounded vocabularies ────────────────────────────────────────────────────

/**
 * Where a memory was opened FROM.
 *
 * The distinction the Explorer could not previously answer: a row click, an
 * arrow-key walk down the list, a duplicate-cluster member, the command
 * palette, and the header's recents dropdown all produced the same (absent)
 * signal. They are different products — `lore-keyboard` working at all is a
 * claim the roving-tabindex work makes, and `lore-cluster` is the only evidence
 * the clusters sidebar is used for anything.
 *
 * `deep-link` is deliberately NOT a member: a `?lesson=`/`?memoryId=` arrival
 * never passes through `openLessonById`, and the page view already carries the
 * param. Inventing an event for it in an effect would double-fire on every
 * re-resolve.
 */
export type MemoryOpenSurface =
  | 'lore-list'
  | 'lore-cluster'
  | 'lore-keyboard'
  | 'command-palette'
  | 'header-recents';

/**
 * Why the detail panel closed.
 *
 * Most of these are not a reader dismissing the panel at all — the Explorer
 * closes it on every filter, scope and status change, because the open memory
 * may not survive the new predicate. Counting those as "the user closed it"
 * would make the panel look abandoned when it was taken away, so the reason is
 * part of the event rather than something to infer from what happened next.
 */
export type MemoryCloseReason =
  | 'toggle'
  | 'panel-close'
  | 'filter-change'
  | 'scope-change'
  | 'status-change'
  | 'cluster-change'
  | 'mutated'
  | 'dismissed';

const MEMORY_CLOSE_REASONS: readonly MemoryCloseReason[] = [
  'toggle',
  'panel-close',
  'filter-change',
  'scope-change',
  'status-change',
  'cluster-change',
  'mutated',
  'dismissed',
];

/**
 * Whether a value is one of the reasons above.
 *
 * Load-bearing rather than defensive: `closeLesson` is passed straight to JSX
 * as `onClick={onClose}` in two places, so React hands it a `MouseEvent` as its
 * first argument. Without this guard that event object would become the
 * attribute — an unbounded, PII-adjacent value on the hottest path in the
 * feature. Anything unrecognised degrades to `dismissed`, which is the honest
 * reading of "a close happened and nobody said why".
 */
export function asMemoryCloseReason(value: unknown): MemoryCloseReason {
  return typeof value === 'string' && (MEMORY_CLOSE_REASONS as readonly string[]).includes(value)
    ? (value as MemoryCloseReason)
    : 'dismissed';
}

/** What a filter-bar mutation did. Retention thresholds ride the same event — see `track.ts`. */
export type LoreFilterAction =
  | 'add'
  | 'remove'
  | 'clear-all'
  | 'operator'
  | 'retention-set'
  | 'retention-remove';

/** Every disclosure on the Explorer, so "does anyone open this" is one query. */
export type LorePanel = 'activity' | 'instruments' | 'duplicate-clusters' | 'scope-browser';

/** The body a panel is showing. `charts`/`heatmap` are the Activity panel's, `matrix`/`timeline` the instruments'. */
export type LorePanelView = 'charts' | 'heatmap' | 'matrix' | 'timeline';

/**
 * Which control wrote `?range=`.
 *
 * The Explorer has FIVE of them (preset rail, calendar, calendar presets,
 * heatmap cells, timeline brush) all writing one param, so without this the
 * event answers "the range changed" and nothing about which affordance earned
 * its place.
 */
export type LoreRangeSource =
  | 'preset-picker'
  | 'calendar'
  | 'calendar-clear'
  | 'heatmap'
  | 'timeline-brush'
  | 'timeline-clear'
  | 'empty-state';

/** The two ways into a scope: the inline chip strip, or the searchable Browse-all list. */
export type LoreScopeSource = 'strip' | 'browse-all';

/** What was done with an instrument. */
export type LoreInstrumentAction =
  | 'row-axis'
  | 'col-axis'
  | 'select-cell'
  | 'select-range'
  | 'clear-range';

/** Which of the detail panel's two content views is showing, and how it was picked. */
export type MemoryContentTab = 'preview' | 'edit';
export type MemoryContentTabSource = 'click' | 'shortcut';

/** An edit either lands or is thrown away. */
export type MemoryEditAction = 'save' | 'discard';
export type MemoryMutationOutcome = 'success' | 'error';

/** Archive is a toggle, so the direction is part of the fact. */
export type MemoryArchiveAction = 'archive' | 'restore';

/** Insights has two independent windows; a bare preset would not say which moved. */
export type InsightsRangeSection = 'agent-activity' | 'scope-consumption';

/** Where a click into the Explorer came from on the Insights page. */
export type InsightsScopeSource = 'scope-consumption' | 'utility-row';

// ── Derivations ─────────────────────────────────────────────────────────────

/**
 * The scope SELECTION's type, with `all` as a first-class value.
 *
 * `null` (the Explorer's default) is not an absence to be omitted — "how many
 * people ever leave All scopes" is the question this attribute exists to
 * answer, and an omitted attribute cannot be grouped by.
 */
export type ScopeSelectionType = ScopePrefix | 'all';

export function scopeSelectionType(scope: string | null): ScopeSelectionType {
  return scope === null ? 'all' : scopeType(scope);
}

/** The preset a range names, or `custom` for an absolute window and `unset` for an untouched param. */
export type RangeTelemetryPreset = RangePreset | 'custom' | 'unset';

export interface RangeTelemetry {
  preset: RangeTelemetryPreset;
  /**
   * How many days the window spans, rounded up. Omitted when the range is
   * unbounded (`all`/`unset`), because "infinite days" is not a number a
   * percentile can use — an absent value is the honest encoding of no bound.
   */
  spanDays?: number;
}

/**
 * Reduce a `?range=` value to a preset name plus a numeric span.
 *
 * Clock-injected like everything in `time-range.ts`, and it resolves through
 * `resolveRange` rather than parsing the bounds again — the legacy
 * `YYYY-MM-DD` arm's inclusive-`to` rule lives there, and a second copy of it
 * here would report a span one day short for every link written before the ISO
 * arm existed.
 */
export function rangeTelemetry(range: TimeRange, nowIso: string): RangeTelemetry {
  const preset: RangeTelemetryPreset =
    range === null ? 'unset' : isPresetRange(range) ? range.preset : 'custom';

  const window = resolveRange(range, nowIso);
  if (window === null) return { preset };

  const span = Date.parse(window.to) - Date.parse(window.from);
  if (!Number.isFinite(span) || span <= 0) return { preset };
  return { preset, spanDays: Math.max(1, Math.ceil(span / DAY_MS)) };
}

/**
 * What a retention-threshold write actually did.
 *
 * The five thresholds arrive as a whole `RetentionConditions` object from a
 * single setter — the menu row, the pill's ×, and "Clear all" all call it — so
 * the ACTION has to be recovered by diffing rather than declared at the call
 * site. Returns `null` when nothing moved, which is what keeps "Clear all" on a
 * bar with no thresholds from emitting a second, empty event beside the
 * dimension one.
 *
 * A multi-field change reports no `field`: naming one of several would be a
 * guess, and an omitted attribute is the honest encoding of "more than one".
 */
export function retentionFilterChange(
  prev: RetentionConditions,
  next: RetentionConditions,
): { action: LoreFilterAction; field?: RetentionField } | null {
  const changed = RETENTION_FIELDS.map(({ field }) => field).filter(
    (field) => prev[field] !== next[field],
  );
  if (changed.length === 0) return null;

  const first = changed[0];
  if (changed.length === 1 && first !== undefined) {
    return {
      action: next[first] === undefined ? 'retention-remove' : 'retention-set',
      field: first,
    };
  }
  const anySet = changed.some((field) => next[field] !== undefined);
  return { action: anySet ? 'retention-set' : 'retention-remove' };
}

/** The buckets a duplicate cluster's size collapses to. */
export type ClusterSizeBucket = '2' | '3-5' | '6-10' | '10+';

/**
 * Bucket a cluster's member count.
 *
 * A raw size is a near-unique fingerprint for a specific cluster in a specific
 * account once it grows, and the question the number answers ("are people
 * acting on the big ones or the small ones") survives bucketing intact.
 */
export function clusterSizeBucket(size: number): ClusterSizeBucket {
  if (size <= 2) return '2';
  if (size <= 5) return '3-5';
  if (size <= 10) return '6-10';
  return '10+';
}
