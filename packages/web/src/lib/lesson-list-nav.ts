/**
 * Pure logic for ArrowUp/ArrowDown keyboard navigation of the Lore Explorer's
 * memory list.
 *
 * Dependency-free with a co-located spec (the functional-core / impure-shell
 * split the package uses — see packages/web/CLAUDE.md and `content-tabs.ts`,
 * which this module mirrors for a flat list instead of a two-tab roving
 * tablist). The component keeps only the DOM wiring — reading
 * `document.activeElement`, calling `preventDefault`, opening the target
 * lesson, and moving focus to its card; the index arithmetic and the "is this
 * a form field" guard live here so they are unit-testable without a DOM.
 */

/**
 * Is `el` a form control that should swallow ArrowUp/ArrowDown instead of
 * letting them drive list navigation?
 *
 * The single canonical home for this check (code-quality: one source of
 * truth) — `LessonDetailSheet`'s P/E shortcut handler delegates here rather
 * than keeping its own inline copy, so the definition of "typing" cannot
 * drift between the two keyboard handlers that both need it.
 *
 * `null`/`undefined` (no active element, or focus on `<body>`) is never a
 * typing target.
 */
export function isTypingTarget(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}

/**
 * The index ArrowDown/ArrowUp should move selection to.
 *
 * `current` is the presently-open lesson's index, or `null` when nothing is
 * open (the first arrow press then opens the first row for ArrowDown, or the
 * last row for ArrowUp — a reasonable "start browsing" default, matching how
 * a native listbox with no selection behaves). Clamped to `[0, length - 1]`
 * — no wraparound, unlike `nextTabForKey`'s two-tab roving list, because a
 * long memory list wrapping from the last row back to the first reads as a
 * bug ("did my Down key just jump me to the top?"), not a feature.
 *
 * Returns `null` for an empty list (nothing to select) or a key that is not
 * ArrowDown/ArrowUp, so the caller can leave the event alone.
 */
export function nextLessonIndex(
  current: number | null,
  key: string,
  length: number,
): number | null {
  if (length <= 0) return null;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;

  if (current === null) {
    return key === 'ArrowDown' ? 0 : length - 1;
  }

  const delta = key === 'ArrowDown' ? 1 : -1;
  return Math.max(0, Math.min(length - 1, current + delta));
}
