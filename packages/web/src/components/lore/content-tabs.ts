/**
 * Pure state logic for the memory-detail Content section's Preview / Edit tabs.
 *
 * Dependency-free with a co-located spec (the functional-core / impure-shell
 * split the package uses — see packages/web/CLAUDE.md). The component keeps only
 * rendering; the tab identity, default, post-save target and roving keyboard
 * navigation live here so they are unit-testable without a DOM.
 */

export type ContentTab = 'preview' | 'edit';

/** The two tabs, in visual (and roving-navigation) order. */
export const CONTENT_TABS = ['preview', 'edit'] as const satisfies readonly ContentTab[];

/** The tab shown when a lesson first opens — Preview is the default view. */
export const DEFAULT_CONTENT_TAB: ContentTab = 'preview';

/**
 * The tab to return to after a successful save. Named (rather than inlining the
 * constant) so the "save → back to Preview" requirement is explicit and tested.
 */
export function tabAfterSave(): ContentTab {
  return DEFAULT_CONTENT_TAB;
}

/**
 * Roving arrow-key navigation for a horizontal tablist (WAI-ARIA Authoring
 * Practices). Returns the tab that should become active for `key`, or `null`
 * when `key` is not a navigation key (the caller then leaves the event alone).
 * Left/Up and Right/Down wrap around the ends; Home/End jump to first/last.
 */
export function nextTabForKey(
  current: ContentTab,
  key: string,
  tabs: readonly ContentTab[] = CONTENT_TABS,
): ContentTab | null {
  const i = tabs.indexOf(current);
  if (i === -1) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return tabs[(i + 1) % tabs.length];
    case 'ArrowLeft':
    case 'ArrowUp':
      return tabs[(i - 1 + tabs.length) % tabs.length];
    case 'Home':
      return tabs[0];
    case 'End':
      return tabs[tabs.length - 1];
    default:
      return null;
  }
}

/**
 * Global single-letter shortcut: `P` → Preview, `E` → Edit. Returns the tab to
 * activate, or `null` to leave the event alone.
 *
 * Deliberately inert when:
 *   - a command modifier is held (`hasModifier`) — never hijack Cmd/Ctrl/Alt+E;
 *   - focus is in a form field (`inFormField`) — so typing "p"/"e" into the
 *     content textarea, the tag input or the expiry input never switches tabs;
 *   - `E` is pressed but editing is disabled (`canEdit` false — archived lesson).
 * Case-insensitive so Caps Lock / a stray Shift still works.
 */
export function shortcutTabForKey(
  key: string,
  opts: { hasModifier: boolean; inFormField: boolean; canEdit: boolean },
): ContentTab | null {
  if (opts.hasModifier || opts.inFormField) return null;
  switch (key.toLowerCase()) {
    case 'p':
      return 'preview';
    case 'e':
      return opts.canEdit ? 'edit' : null;
    default:
      return null;
  }
}
