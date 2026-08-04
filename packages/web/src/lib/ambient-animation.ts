/**
 * When a decorative, self-looping animation is allowed to run.
 *
 * The functional core behind `lib/hooks/useAmbientAnimation.ts`. An "ambient"
 * animation is one nobody asked for and nobody waits on — the login page's
 * `TerminalTheater` is the reference: it types characters on a 16ms interval
 * and restarts itself forever.
 *
 * The rule is deliberately narrow. Running such a loop while it is scrolled out
 * of view or while the tab is in the background buys the visitor nothing and
 * costs them two measurable things:
 *
 * - **Layout shifts keep accruing.** Every re-render of a text run that reflows
 *   is a CLS entry, and CLS is a session-cumulative metric — it never decays.
 *   A loop that runs for the whole visit therefore keeps adding to the score
 *   long after the visitor stopped looking at it.
 * - **Main-thread work competes with the visitor's own input.** The interval
 *   fires ~60 times a second and each tick re-renders a React subtree. That is
 *   the work an INP measurement is queued behind when the visitor finally
 *   clicks something.
 *
 * Reduced motion is deliberately NOT a term here: `TerminalTheater` honours
 * `prefers-reduced-motion` by rendering its end state instead of animating, so
 * a reduced-motion visitor has no loop to gate in the first place. Folding it
 * in would make this predicate the only thing standing between that visitor and
 * a blank panel.
 */

/** Inputs the decision is made from. */
export interface AmbientAnimationConditions {
  /** The element is intersecting the viewport. */
  onScreen: boolean;
  /** The document is the foreground tab (`document.visibilityState`). */
  pageVisible: boolean;
}

/**
 * Whether an ambient animation should be running right now.
 *
 * Both conditions must hold: an off-screen animation is invisible, and a
 * background tab throttles timers unpredictably rather than stopping them, so
 * neither case is self-correcting.
 */
export function shouldAnimate({ onScreen, pageVisible }: AmbientAnimationConditions): boolean {
  return onScreen && pageVisible;
}

/**
 * The `onScreen` value to hold whenever the element cannot be observed.
 *
 * This constant IS the fail-open rule: with no `IntersectionObserver` the hook
 * never learns whether the element is on screen, so it must assume it is and
 * let the animation run exactly as it did before the gate existed. A
 * decorative animation degrades to "plays too much", never to "empty panel".
 */
export const ON_SCREEN_WHEN_UNOBSERVABLE = true;

/**
 * Whether an `IntersectionObserver` can be attached yet.
 *
 * Two independent reasons it cannot: the callback ref has not handed us the
 * node yet (first render — the element is mounted by the caller's own render,
 * so there is nothing to observe on the first pass), or the browser has no
 * `IntersectionObserver` at all. The caller supplies the second term so this
 * stays free of any global lookup.
 */
export function canObserve<T>(node: T | null, hasObserver: boolean): node is T {
  return node !== null && hasObserver;
}

/**
 * The `onScreen` value to adopt from an `IntersectionObserver` callback.
 *
 * The observer watches exactly one element, so only the first entry is
 * meaningful. An empty batch is not a signal that the element left the
 * viewport — it carries no information at all — so the current value is held
 * rather than defaulted either way.
 */
export function onScreenFrom(
  entries: readonly { isIntersecting: boolean }[],
  current: boolean,
): boolean {
  const entry = entries[0];
  return entry ? entry.isIntersecting : current;
}

/**
 * Whether the document is the foreground tab.
 *
 * Only `'visible'` counts. `'hidden'`, `'prerender'` and — on the server, where
 * there is no `document` — `undefined` all read as "not the foreground tab",
 * which is the conservative side for a gate whose false value only pauses a
 * decorative loop.
 */
export function isPageVisible(state: string | undefined): boolean {
  return state === 'visible';
}
