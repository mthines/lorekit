/**
 * The visibility rule for the header's background-activity indicator.
 *
 * A naive `isFetching > 0 ? <bar/> : null` is worse than no indicator at all:
 * a cached read resolves in a few milliseconds, so the bar appears and vanishes
 * within one or two frames and reads as a glitch in the chrome rather than as
 * progress. Two thresholds fix that, and they are opposites — one keeps the bar
 * away, the other keeps it around:
 *
 * - `SHOW_DELAY_MS` — a request must still be running after this long before it
 *   is worth announcing. Anything faster never renders at all.
 * - `MIN_VISIBLE_MS` — once the bar IS on screen it stays for at least this
 *   long, so a request that finishes just past the delay does not flash.
 *
 * A third threshold, `MAX_VISIBLE_MS`, is neither: it is the point at which the
 * rule stops believing the request it is reporting. See its docblock.
 *
 * The rule is a state machine rather than two booleans because "waiting to
 * appear" and "waiting to disappear" are distinct states with distinct exits,
 * and the interesting case is the one that crosses them: activity restarting
 * while the bar is lingering must keep the SAME bar on screen (no exit + enter
 * animation) rather than starting a second cycle.
 *
 * It is pure and clock-free — the component owns the timers and feeds their
 * expiry back in as an event — so every transition is unit-testable without
 * fake timers or a rendered tree.
 */

/** How long a request must run before the indicator is worth showing. */
export const SHOW_DELAY_MS = 150;

/** How long the indicator stays once shown, even if the work already finished. */
export const MIN_VISIBLE_MS = 450;

/**
 * The longest the indicator will claim work is in flight before giving up on it.
 *
 * The other two thresholds assume every request eventually reports back; this
 * one covers the case where none ever does. A fetch with no deadline, a request
 * abandoned mid-flight that cannot be cancelled, a server action superseded by
 * a navigation — each leaves a query that is *still fetching* as far as the
 * count is concerned, and with only `activity-end` to leave `visible` by, the
 * bar sweeps forever over an app that finished loading long ago.
 *
 * Chrome that lies indefinitely is worse than chrome that gives up: a user who
 * has seen the list render reads a permanent bar as "this app is broken", and
 * the screen reader's live region says "Refreshing data" for the rest of the
 * session. So the bar stops reporting — but only past the point where the app
 * itself has stopped waiting.
 *
 * That point is `REST_TIMEOUT_MS` (30s, `lib/api/rest.ts`), the longest a single
 * request is allowed to run before it is abandoned with an error. A watchdog
 * shorter than that gives up on work the app still expects an answer from: the
 * bar would vanish mid-flight and, per the no-resurrect consequence documented
 * in `useBackgroundActivity`, would not come back when the answer arrived. So
 * this must OUTLAST one deadline — the extra 5s covers the abort propagating
 * and the query settling. `activity-indicator.spec.ts` asserts the ordering, so
 * moving either number without the other fails the suite.
 *
 * It does NOT outlast every case, and should not pretend to: a query with
 * `retry` configured stays in flight across several deadlines plus backoff, and
 * a watchdog set past that envelope would be a bar that lies for minutes. The
 * bound is one request's worth of patience, not every retry's.
 */
export const MAX_VISIBLE_MS = 35_000;

export type IndicatorState =
  /** Nothing in flight, nothing on screen. */
  | 'idle'
  /** Work started; waiting out `SHOW_DELAY_MS` to see if it is slow enough to announce. */
  | 'pending'
  /** On screen, work still running. */
  | 'visible'
  /** On screen, work already finished; waiting out `MIN_VISIBLE_MS`. */
  | 'lingering';

export type IndicatorEvent =
  /** The number of in-flight requests went from zero to non-zero. */
  | 'activity-start'
  /** The number of in-flight requests went back to zero. */
  | 'activity-end'
  /** `SHOW_DELAY_MS` elapsed while still in `pending`. */
  | 'delay-elapsed'
  /** `MIN_VISIBLE_MS` elapsed while still in `lingering`. */
  | 'linger-elapsed'
  /** `MAX_VISIBLE_MS` elapsed while still in `visible` — the work never reported back. */
  | 'max-visible-elapsed';

/**
 * The next state for an event, or the current state when the event does not
 * apply (a stale timer firing after the state already moved on, say). Total by
 * construction: every state/event pair has an answer, so no caller has to
 * defend against an undefined transition.
 */
export function nextIndicatorState(state: IndicatorState, event: IndicatorEvent): IndicatorState {
  switch (state) {
    case 'idle':
      return event === 'activity-start' ? 'pending' : 'idle';
    case 'pending':
      if (event === 'delay-elapsed') return 'visible';
      if (event === 'activity-end') return 'idle';
      return 'pending';
    case 'visible':
      if (event === 'activity-end') return 'lingering';
      // Straight to `idle`, not through `lingering`: the linger exists to keep a
      // bar that appeared too briefly on screen, and this one has been up for
      // `MAX_VISIBLE_MS`. Nothing is owed to a request that never came back.
      if (event === 'max-visible-elapsed') return 'idle';
      return 'visible';
    case 'lingering':
      // Work restarting while the bar is still up keeps the same bar — the user
      // sees continuous progress, not a flicker between two cycles.
      if (event === 'activity-start') return 'visible';
      if (event === 'linger-elapsed') return 'idle';
      return 'lingering';
  }
}

/** Whether the indicator renders in this state. */
export function isIndicatorVisible(state: IndicatorState): boolean {
  return state === 'visible' || state === 'lingering';
}
