/**
 * Pure "N clicks in a row" gesture detector — the logic behind the
 * developer-nav reveal toggle (`UserSettingsPanel.tsx`'s avatar: 5 clicks
 * within the window reveals `/settings/developer` in the nav, 5 more hides
 * it again). Kept pure and dependency-free so the counting rule — what "in a
 * row" means — is unit-tested directly, rather than only exercisable by
 * actually clicking a rendered button in a browser test.
 *
 * "In a row" = every click in the run landed within `windowMs` of the
 * click before it — NOT all within `windowMs` of the FIRST click. A rolling
 * window (not a fixed one) means a deliberate steady rhythm of clicks always
 * counts, however long the whole sequence takes, while a slow, absent-minded
 * click days apart from the rest never accidentally chains into a trigger.
 */

/** One click registered; returns the new run length and whether it just hit `threshold`. */
export interface ClickGestureResult {
  /** The run length after this click — 1 if the previous click fell outside `windowMs`. */
  runLength: number;
  /** Whether this click completed the run — the caller should act and reset. */
  triggered: boolean;
}

/**
 * @param lastClickAt `null` before the first click, or the previous
 *   `registerClick` call's timestamp otherwise.
 * @param runLengthSoFar the run length going into this click (0 before the first).
 * @param now the current click's timestamp (`Date.now()` at the call site — a
 *   parameter, not read internally, so this stays pure and testable).
 * @param windowMs the maximum gap between consecutive clicks that still counts
 *   as "in a row".
 * @param threshold the run length that triggers.
 */
export function registerClick(
  lastClickAt: number | null,
  runLengthSoFar: number,
  now: number,
  windowMs: number,
  threshold: number,
): ClickGestureResult {
  const inWindow = lastClickAt !== null && now - lastClickAt <= windowMs;
  const runLength = inWindow ? runLengthSoFar + 1 : 1;
  return { runLength, triggered: runLength >= threshold };
}
