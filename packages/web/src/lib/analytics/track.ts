/**
 * Analytics — centralized RUM event wrapper.
 *
 * The ONLY module through which *product* events reach the Dash0 Web SDK.
 * Feature code emits *typed* events via `track(...)`, so swapping vendors or
 * renaming an attribute is a single-file change for everything in the catalog
 * below. Telemetry is best-effort — a failure here must NEVER break the UI.
 *
 * There is exactly one other caller of `sendEvent` in the app:
 * `lib/auth-telemetry.ts`. It stays separate because `AnalyticsEvent` models
 * only event name → attributes, while the auth events additionally need a
 * per-event `title` and a `severity` (`auth.failure` is deliberately `WARN`);
 * routing them through `track` as it stands would silently drop both. It
 * guards its own `sendEvent` call exactly as this module does. **Do not add a
 * third caller** — extend this catalog, or extend `track`'s signature to carry
 * `title`/`severity` and fold auth back in. That is not just an ask:
 * `sdk-event-callers.spec.ts` scans the source tree and fails on any module
 * outside those two importing `sendEvent`, so adding one costs a visible edit
 * to the allowlist there.
 *
 * ## Event catalog (source of truth — keep dashboards in sync)
 * - `command_palette.opened`           — the palette overlay was shown.
 * - `command_palette.command_selected` — a command was executed (leaf onSelect).
 * - `install_command.copied`           — a visitor copied a shell command to the clipboard.
 * - `content.scroll_depth`             — a reader crossed 25/50/75/100 % of an article.
 * - `content.section_read`             — a reader left a section, after dwelling in it.
 * - `content.read`                     — end-of-page-view reading summary (one per view).
 * - `ui.button_click`                  — a primitive Button/IconButton carrying an
 *                                        `analyticsId` was clicked (the id is the
 *                                        static developer-authored slug, plus the
 *                                        visual variant/size).
 *
 * ### Lore Explorer (`lore.*`)
 * - `lore.memory_opened`               — a memory was selected into the detail panel.
 * - `lore.memory_closed`               — the detail panel was dismissed, with WHY.
 * - `lore.memory_content_tab`          — Preview ⇄ Edit inside the detail panel.
 * - `lore.memory_edit`                 — an edit was saved or discarded.
 * - `lore.memory_archive_toggled`      — a memory was archived or restored.
 * - `lore.filter_changed`              — any filter-bar mutation, thresholds included.
 * - `lore.status_changed`              — Active / Archived / Expiring.
 * - `lore.search_committed`            — the debounced search settled.
 * - `lore.scope_selected`              — a scope chip (or Browse-all row) was picked.
 * - `lore.range_changed`               — any of the FIVE controls that write `?range=`.
 * - `lore.panel_toggled`               — a disclosure opened or closed.
 * - `lore.view_changed`                — a panel swapped its body (charts/heatmap, matrix/timeline).
 * - `lore.instrument_used`             — a matrix axis/cell or a timeline brush.
 * - `lore.cluster_selected`            — a duplicate cluster drove the list, or was cleared.
 * - `lore.results_paged`               — "Load more" appended a page.
 *
 * ### Insights (`insights.*`)
 * - `insights.range_changed`           — one of the page's TWO independent windows moved.
 * - `insights.utility_quadrant_selected` — a utility quadrant was opened or closed.
 * - `insights.utility_prompt_copied`   — a grooming prompt reached the clipboard.
 * - `insights.scope_opened`            — a row handed off to the Explorer.
 *
 * ## PII / cardinality
 * Command ids are a fixed enum EXCEPT the dynamic "Open Lesson…" children, whose
 * ids embed `scope::key` (user content + unbounded cardinality). `normalizeCommandId`
 * buckets those to `lore-lesson`, and we NEVER send a command's label or
 * description (lesson keys/scopes are user content). The same discipline applies to
 * `ui.button_click`: `buttonId` is a STATIC, developer-authored `<surface>.<action>`
 * slug (bounded, like `commandId`'s static ids) — never a label, never user content,
 * never an interpolated/template string. Attribute names use the project's
 * `lorekit.*` namespace, mirroring packages/mcp-core/src/telemetry/telemetry.ts.
 *
 * The `lore.*` / `insights.*` families are that same discipline applied to the
 * one surface where nearly everything a reader touches IS user content — a
 * scope, a label, a memory key, a search term. None of them reaches an
 * attribute: `lib/analytics/lore-events.ts` holds the derivations that reduce
 * each to something bounded (a scope to its TYPE, a filter to its FIELD, a
 * search to its LENGTH, a cluster to a size BUCKET), and every other value on
 * those events is a closed union declared there. Read that module before adding
 * an attribute to one of them.
 */
import { sendEvent } from '@dash0/sdk-web';

import type { ButtonSize, ButtonVariant } from '@/lib/button-styles';
import type { FilterField, FilterOperator } from '@/lib/filters';
import type { LessonUtility } from '@/lib/lesson-utility';
import type { MemoryStatus } from '@/lib/status-filter';

import { dwellBucket, type ContentType, type ScrollMilestone } from './reading';
import type {
  ClusterSizeBucket,
  InsightsRangeSection,
  InsightsScopeSource,
  LoreFilterAction,
  LoreInstrumentAction,
  LorePanel,
  LorePanelView,
  LoreRangeSource,
  LoreScopeSource,
  MemoryArchiveAction,
  MemoryCloseReason,
  MemoryContentTab,
  MemoryContentTabSource,
  MemoryEditAction,
  MemoryMutationOutcome,
  MemoryOpenSurface,
  RangeTelemetryPreset,
  ScopeSelectionType,
} from './lore-events';

/**
 * How the palette was opened. `button` is the desktop `⌘K` chip in the header;
 * `fab` is the docked disc in the mobile tab bar. They are kept apart because
 * the whole point of the FAB is that the header chip was unreachable on a
 * phone — collapsing both to `button` would hide whether that is true.
 */
export type PaletteTrigger = 'shortcut' | 'button' | 'fab';

/** How a command was executed. */
export type CommandSource = 'palette' | 'shortcut';

/**
 * Which shell command was copied. A bounded id, never the command STRING:
 * `CopyCommand` takes arbitrary text, and an attribute built from it would be
 * unbounded the moment a second call site passes something interpolated.
 * Add an id here when you add a copyable command.
 */
export type InstallCommandId = 'cli-install';

/** Where the copy affordance was rendered. Bounded for the same reason. */
export type CopySurface = 'login-get-started' | 'blog-cta';

/** Discriminated union of every tracked event. Add new events here. */
export type AnalyticsEvent =
  | { name: 'command_palette.opened'; trigger: PaletteTrigger }
  | {
      name: 'command_palette.command_selected';
      commandId: string;
      group?: string;
      source: CommandSource;
    }
  | {
      name: 'install_command.copied';
      commandId: InstallCommandId;
      surface: CopySurface;
      /**
       * Whether the clipboard write actually succeeded. A denied clipboard —
       * an insecure context, a hardened browser, a permissions prompt the
       * visitor dismissed — currently fails SILENTLY in `CopyCommand`, leaving
       * the visitor with a button that does nothing. Recording the outcome is
       * what makes that visible; counting only successes would hide it.
       */
      succeeded: boolean;
    }
  | {
      name: 'content.scroll_depth';
      contentType: ContentType;
      slug: string;
      depthPercent: ScrollMilestone;
    }
  | {
      name: 'content.section_read';
      contentType: ContentType;
      slug: string;
      /** The heading id — the same value the TOC links to. */
      sectionId: string;
      /** Position in the TOC, so "did anyone reach section 7" needs no join. */
      sectionIndex: number;
      dwellMs: number;
    }
  | {
      name: 'content.read';
      contentType: ContentType;
      slug: string;
      maxDepthPercent: number;
      /** Visible, non-idle time. See `ReadingTelemetry` for what does NOT count. */
      engagedMs: number;
      sectionsRead: number;
      /** The section that held them longest, when any section did. */
      topSectionId?: string;
      completed: boolean;
    }
  | {
      name: 'ui.button_click';
      /**
       * A STATIC `<surface>.<action>` slug authored at the call site (e.g.
       * `invite.accept`). Bounded and developer-controlled — never a label,
       * user content, or an interpolated string. Enforced by
       * `components/ui/analytics-id-literals.spec.ts`.
       */
      buttonId: string;
      /** The button's visual variant, when set — a bounded enum. */
      variant?: ButtonVariant;
      /** The button's size, when set — a bounded enum. */
      size?: ButtonSize;
    }
  // ── Lore Explorer ─────────────────────────────────────────────────────────
  | {
      name: 'lore.memory_opened';
      surface: MemoryOpenSurface;
      /** The scope's TYPE, never the scope — see `lore-events.ts`. */
      scopeType: ScopeSelectionType;
      /**
       * The row's position in the list, when the caller has one. A MEASURE, so
       * "does anyone reach past the fifth row" is a percentile rather than a
       * group-by over an unbounded integer.
       */
      index?: number;
    }
  | { name: 'lore.memory_closed'; reason: MemoryCloseReason }
  | { name: 'lore.memory_content_tab'; tab: MemoryContentTab; source: MemoryContentTabSource }
  | {
      name: 'lore.memory_edit';
      action: MemoryEditAction;
      /** Present on a save, absent on a discard — a discard has no outcome to report. */
      outcome?: MemoryMutationOutcome;
      /**
       * WHICH of the three editable fields actually moved. A save that only
       * re-tags is a different act from one that rewrites the body, and the
       * panel offers all three in one form, so without this every save looks
       * alike. Sent unconditionally on a save — a `false` is a row, not an
       * absence, exactly as `install_command.succeeded` is.
       */
      changedValue?: boolean;
      changedTags?: boolean;
      changedTtl?: boolean;
    }
  | {
      name: 'lore.memory_archive_toggled';
      action: MemoryArchiveAction;
      outcome: MemoryMutationOutcome;
    }
  | {
      name: 'lore.filter_changed';
      action: LoreFilterAction;
      /**
       * The dimension or threshold touched — a bounded field name, NEVER the
       * value, which is the reader's own label / host / repo. Absent on
       * `clear-all`, which touches every dimension at once.
       */
      field?: FilterField | string;
      operator?: FilterOperator;
      /** How many dimension pills the bar carries AFTER the change. A measure. */
      filterCount: number;
      /** How many age/activity thresholds it carries after the change. A measure. */
      retentionCount: number;
    }
  | { name: 'lore.status_changed'; status: MemoryStatus }
  | {
      name: 'lore.search_committed';
      /**
       * The query's LENGTH, never the query — a search term is the most
       * content-bearing thing a reader types on this page. Zero means the box
       * was cleared, which is why it is sent rather than omitted.
       */
      queryLength: number;
    }
  | { name: 'lore.scope_selected'; scopeType: ScopeSelectionType; source: LoreScopeSource }
  | {
      name: 'lore.range_changed';
      preset: RangeTelemetryPreset;
      source: LoreRangeSource;
      /** Omitted for an unbounded window — see `rangeTelemetry`. A measure. */
      spanDays?: number;
    }
  | { name: 'lore.panel_toggled'; panel: LorePanel; open: boolean }
  | { name: 'lore.view_changed'; panel: LorePanel; view: LorePanelView }
  | {
      name: 'lore.instrument_used';
      instrument: 'matrix' | 'timeline';
      action: LoreInstrumentAction;
      /** The axis's dimension, on an axis change. Bounded; never a cell's value. */
      field?: FilterField;
    }
  | {
      name: 'lore.cluster_selected';
      action: 'select' | 'clear';
      /** Bucketed — a raw member count fingerprints one cluster. Absent on a clear. */
      sizeBucket?: ClusterSizeBucket;
    }
  | {
      name: 'lore.results_paged';
      /** Which page was appended (1 = the second page). A measure. */
      page: number;
    }
  // ── Insights ──────────────────────────────────────────────────────────────
  | {
      name: 'insights.range_changed';
      /** The page carries TWO independent windows; a bare preset would not say which moved. */
      section: InsightsRangeSection;
      preset: RangeTelemetryPreset;
      spanDays?: number;
    }
  | {
      name: 'insights.utility_quadrant_selected';
      quadrant: LessonUtility;
      /** False when the click DESELECTED the quadrant — the same control does both. */
      selected: boolean;
    }
  | {
      name: 'insights.utility_prompt_copied';
      quadrant: LessonUtility;
      /** How many lessons the prompt carried. A measure. */
      entryCount: number;
      /**
       * Whether the clipboard write landed. `install_command.copied`'s reason:
       * a denied clipboard fails silently here too, and counting only successes
       * renders a broken affordance as a lack of interest.
       */
      succeeded: boolean;
    }
  | { name: 'insights.scope_opened'; scopeType: ScopeSelectionType; source: InsightsScopeSource };

/**
 * Dynamic lesson commands embed `scope::key` in their id (user content +
 * unbounded cardinality). Collapse them to a single stable bucket so we can
 * count "a lesson was opened" without leaking keys or exploding cardinality.
 * Every other (static) command id passes through unchanged.
 */
export function normalizeCommandId(id: string): string {
  return id.startsWith('lore-lesson-') ? 'lore-lesson' : id;
}

/**
 * An OTel attribute value we are prepared to send. Numbers are deliberate:
 * `dwell_ms` and `max_depth_percent` get averaged and percentiled in Dash0, and
 * a stringified number can only be grouped by. Every value that is a LABEL
 * stays a string.
 */
type AttributeValue = string | number;

/** Map a typed event to its bounded, `lorekit.*`-namespaced OTel attributes. */
function toAttributes(event: AnalyticsEvent): Record<string, AttributeValue> {
  switch (event.name) {
    case 'command_palette.opened':
      return { 'lorekit.command_palette.trigger': event.trigger };
    case 'command_palette.command_selected': {
      const attrs: Record<string, string> = {
        'lorekit.command.id': normalizeCommandId(event.commandId),
        'lorekit.command.source': event.source,
      };
      if (event.group) attrs['lorekit.command.group'] = event.group;
      return attrs;
    }
    case 'install_command.copied':
      return {
        'lorekit.install_command.id': event.commandId,
        'lorekit.install_command.surface': event.surface,
        'lorekit.install_command.succeeded': String(event.succeeded),
      };
    case 'content.scroll_depth':
      return {
        'lorekit.content.type': event.contentType,
        'lorekit.content.slug': event.slug,
        'lorekit.content.depth_percent': event.depthPercent,
      };
    case 'content.section_read': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.content.type': event.contentType,
        'lorekit.content.slug': event.slug,
        'lorekit.content.section.id': event.sectionId,
        'lorekit.content.section.dwell_ms': event.dwellMs,
        'lorekit.content.section.dwell_bucket': dwellBucket(event.dwellMs),
      };
      // `indexOf` yields -1 for a heading that is not in the TOC. Omit rather
      // than ship a sentinel that would sort ahead of section 0 in every panel.
      if (event.sectionIndex >= 0) attrs['lorekit.content.section.index'] = event.sectionIndex;
      return attrs;
    }
    case 'content.read': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.content.type': event.contentType,
        'lorekit.content.slug': event.slug,
        'lorekit.content.max_depth_percent': event.maxDepthPercent,
        'lorekit.content.engaged_ms': event.engagedMs,
        'lorekit.content.engaged_bucket': dwellBucket(event.engagedMs),
        'lorekit.content.sections_read': event.sectionsRead,
        // A string, like `install_command.succeeded` — and unconditional, so a
        // `false` is a row rather than an absence.
        'lorekit.content.completed': String(event.completed),
      };
      if (event.topSectionId) attrs['lorekit.content.top_section.id'] = event.topSectionId;
      return attrs;
    }
    case 'ui.button_click': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.ui.button_id': event.buttonId,
      };
      // Variant/size are optional on the event; omit rather than ship an empty
      // string that would sort ahead of every real value in a Dash0 group-by.
      if (event.variant) attrs['lorekit.ui.button_variant'] = event.variant;
      if (event.size) attrs['lorekit.ui.button_size'] = event.size;
      return attrs;
    }

    // ── Lore Explorer ───────────────────────────────────────────────────────
    case 'lore.memory_opened': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.lore.memory.surface': event.surface,
        'lorekit.lore.memory.scope_type': event.scopeType,
      };
      // Omitted rather than sent as -1 when the caller has no position (the
      // command palette, the header dropdown): a sentinel would sort ahead of
      // row 0 in every percentile.
      if (event.index !== undefined && event.index >= 0) {
        attrs['lorekit.lore.memory.index'] = event.index;
      }
      return attrs;
    }
    case 'lore.memory_closed':
      return { 'lorekit.lore.memory.close_reason': event.reason };
    case 'lore.memory_content_tab':
      return {
        'lorekit.lore.memory.content_tab': event.tab,
        'lorekit.lore.memory.content_tab_source': event.source,
      };
    case 'lore.memory_edit': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.lore.memory.edit_action': event.action,
      };
      if (event.outcome) attrs['lorekit.lore.memory.edit_outcome'] = event.outcome;
      // Strings, like `install_command.succeeded`, and unconditional whenever
      // the caller supplied them — a `false` is what says "the body did NOT
      // change on this save", which is the whole point of the three flags.
      if (event.changedValue !== undefined) {
        attrs['lorekit.lore.memory.changed_value'] = String(event.changedValue);
      }
      if (event.changedTags !== undefined) {
        attrs['lorekit.lore.memory.changed_tags'] = String(event.changedTags);
      }
      if (event.changedTtl !== undefined) {
        attrs['lorekit.lore.memory.changed_ttl'] = String(event.changedTtl);
      }
      return attrs;
    }
    case 'lore.memory_archive_toggled':
      return {
        'lorekit.lore.memory.archive_action': event.action,
        'lorekit.lore.memory.archive_outcome': event.outcome,
      };
    case 'lore.filter_changed': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.lore.filter.action': event.action,
        'lorekit.lore.filter.count': event.filterCount,
        'lorekit.lore.filter.retention_count': event.retentionCount,
      };
      if (event.field) attrs['lorekit.lore.filter.field'] = event.field;
      if (event.operator) attrs['lorekit.lore.filter.operator'] = event.operator;
      return attrs;
    }
    case 'lore.status_changed':
      return { 'lorekit.lore.status': event.status };
    case 'lore.search_committed':
      // A measure, and unconditional: a 0 is the reader CLEARING the box, which
      // is as much a fact as typing into it.
      return { 'lorekit.lore.search.length': event.queryLength };
    case 'lore.scope_selected':
      return {
        'lorekit.lore.scope.type': event.scopeType,
        'lorekit.lore.scope.source': event.source,
      };
    case 'lore.range_changed': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.lore.range.preset': event.preset,
        'lorekit.lore.range.source': event.source,
      };
      if (event.spanDays !== undefined) attrs['lorekit.lore.range.span_days'] = event.spanDays;
      return attrs;
    }
    case 'lore.panel_toggled':
      return {
        'lorekit.lore.panel.name': event.panel,
        'lorekit.lore.panel.open': String(event.open),
      };
    case 'lore.view_changed':
      return {
        'lorekit.lore.view.panel': event.panel,
        'lorekit.lore.view.name': event.view,
      };
    case 'lore.instrument_used': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.lore.instrument.name': event.instrument,
        'lorekit.lore.instrument.action': event.action,
      };
      if (event.field) attrs['lorekit.lore.instrument.field'] = event.field;
      return attrs;
    }
    case 'lore.cluster_selected': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.lore.cluster.action': event.action,
      };
      if (event.sizeBucket) attrs['lorekit.lore.cluster.size_bucket'] = event.sizeBucket;
      return attrs;
    }
    case 'lore.results_paged':
      return { 'lorekit.lore.results.page': event.page };

    // ── Insights ────────────────────────────────────────────────────────────
    case 'insights.range_changed': {
      const attrs: Record<string, AttributeValue> = {
        'lorekit.insights.range.section': event.section,
        'lorekit.insights.range.preset': event.preset,
      };
      if (event.spanDays !== undefined) attrs['lorekit.insights.range.span_days'] = event.spanDays;
      return attrs;
    }
    case 'insights.utility_quadrant_selected':
      return {
        'lorekit.insights.utility.quadrant': event.quadrant,
        // A deselect is the same control and must be countable apart from a
        // select, so this is a string rather than an omitted attribute.
        'lorekit.insights.utility.selected': String(event.selected),
      };
    case 'insights.utility_prompt_copied':
      return {
        'lorekit.insights.utility.quadrant': event.quadrant,
        'lorekit.insights.utility.entry_count': event.entryCount,
        'lorekit.insights.utility.succeeded': String(event.succeeded),
      };
    case 'insights.scope_opened':
      return {
        'lorekit.insights.scope.type': event.scopeType,
        'lorekit.insights.scope.source': event.source,
      };
  }
}

/** Emit a typed RUM event. Best-effort: silently no-ops if the SDK is absent. */
export function track(event: AnalyticsEvent): void {
  try {
    sendEvent(event.name, { attributes: toAttributes(event) });
  } catch {
    // Telemetry is best-effort; never let it break the UI.
  }
}
