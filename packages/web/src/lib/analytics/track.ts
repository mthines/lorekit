/**
 * Analytics — centralized RUM event wrapper.
 *
 * The ONLY module that calls the Dash0 Web SDK's event API (`sendEvent`).
 * Feature code emits *typed* events via `track(...)`, so swapping vendors or
 * renaming an attribute is a single-file change. Telemetry is best-effort — a
 * failure here must NEVER break the UI.
 *
 * ## Event catalog (source of truth — keep dashboards in sync)
 * - `command_palette.opened`           — the palette overlay was shown.
 * - `command_palette.command_selected` — a command was executed (leaf onSelect).
 *
 * ## PII / cardinality
 * Command ids are a fixed enum EXCEPT the dynamic "Open Lesson…" children, whose
 * ids embed `scope::key` (user content + unbounded cardinality). `normalizeCommandId`
 * buckets those to `lore-lesson`, and we NEVER send a command's label or
 * description (lesson keys/scopes are user content). Attribute names use the
 * project's `lorekit.*` namespace, mirroring packages/mcp-core/src/telemetry.ts.
 */
import { sendEvent } from '@dash0/sdk-web';

/** How the palette was opened. */
export type PaletteTrigger = 'shortcut' | 'button';

/** How a command was executed. */
export type CommandSource = 'palette' | 'shortcut';

/** Discriminated union of every tracked event. Add new events here. */
export type AnalyticsEvent =
  | { name: 'command_palette.opened'; trigger: PaletteTrigger }
  | {
      name: 'command_palette.command_selected';
      commandId: string;
      group?: string;
      source: CommandSource;
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

/** Map a typed event to its bounded, `lorekit.*`-namespaced OTel attributes. */
function toAttributes(event: AnalyticsEvent): Record<string, string> {
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
