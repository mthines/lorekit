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
 *
 * ## PII / cardinality
 * Command ids are a fixed enum EXCEPT the dynamic "Open Lesson…" children, whose
 * ids embed `scope::key` (user content + unbounded cardinality). `normalizeCommandId`
 * buckets those to `lore-lesson`, and we NEVER send a command's label or
 * description (lesson keys/scopes are user content). Attribute names use the
 * project's `lorekit.*` namespace, mirroring packages/mcp-core/src/telemetry.ts.
 */
import { sendEvent } from '@dash0/sdk-web';

import { dwellBucket, type ContentType, type ScrollMilestone } from './reading';

/** How the palette was opened. */
export type PaletteTrigger = 'shortcut' | 'button';

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
    };

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
