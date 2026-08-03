import { describe, it, expect } from 'vitest';
import {
  MAX_VISIBLE_MS,
  MIN_VISIBLE_MS,
  SHOW_DELAY_MS,
  isIndicatorVisible,
  nextIndicatorState,
  type IndicatorEvent,
  type IndicatorState,
} from './activity-indicator';
import { REST_TIMEOUT_MS } from './api/rest';

const STATES: IndicatorState[] = ['idle', 'pending', 'visible', 'lingering'];
const EVENTS: IndicatorEvent[] = [
  'activity-start',
  'activity-end',
  'delay-elapsed',
  'linger-elapsed',
  'max-visible-elapsed',
];

/** Replay a sequence of events from `idle` and report where it lands. */
function run(...events: IndicatorEvent[]): IndicatorState {
  return events.reduce<IndicatorState>(nextIndicatorState, 'idle');
}

describe('activity indicator state machine', () => {
  it('does not show a request that finishes before the delay elapses', () => {
    const state = run('activity-start', 'activity-end');
    expect(state).toBe('idle');
    expect(isIndicatorVisible(state)).toBe(false);
  });

  it('shows a request that is still running once the delay elapses', () => {
    const state = run('activity-start', 'delay-elapsed');
    expect(state).toBe('visible');
    expect(isIndicatorVisible(state)).toBe(true);
  });

  it('keeps the bar on screen after the work finishes, until the linger elapses', () => {
    const lingering = run('activity-start', 'delay-elapsed', 'activity-end');
    expect(isIndicatorVisible(lingering)).toBe(true);
    expect(nextIndicatorState(lingering, 'linger-elapsed')).toBe('idle');
  });

  it('absorbs new work into the bar already on screen instead of restarting the cycle', () => {
    // The flicker case: a second request arrives during the linger. It must not
    // drop back to `pending` (which would hide the bar mid-progress).
    const state = run('activity-start', 'delay-elapsed', 'activity-end', 'activity-start');
    expect(state).toBe('visible');
  });

  it('gives up on work that never reports back, instead of sweeping forever', () => {
    // The wedge: a request whose promise never settles sends no `activity-end`,
    // so `visible` has no other exit and the chrome claims the app is busy for
    // the rest of the session.
    const state = run('activity-start', 'delay-elapsed', 'max-visible-elapsed');
    expect(state).toBe('idle');
    expect(isIndicatorVisible(state)).toBe(false);
  });

  it('drops the bar immediately when the watchdog fires — the linger is not owed', () => {
    // Straight to `idle`, never via `lingering`: the linger keeps a bar that
    // appeared too briefly on screen, and this one has been up for the whole
    // watchdog window.
    expect(nextIndicatorState('visible', 'max-visible-elapsed')).toBe('idle');
  });

  it('never lets the watchdog cut short a state that is not showing a live request', () => {
    // Only `visible` arms the timer, so these are all stale firings.
    expect(nextIndicatorState('idle', 'max-visible-elapsed')).toBe('idle');
    expect(nextIndicatorState('pending', 'max-visible-elapsed')).toBe('pending');
    expect(nextIndicatorState('lingering', 'max-visible-elapsed')).toBe('lingering');
  });

  it('ignores a stale timer that fires after the state moved on', () => {
    // `delay-elapsed` from a cancelled cycle must not raise an idle indicator.
    expect(nextIndicatorState('idle', 'delay-elapsed')).toBe('idle');
    expect(nextIndicatorState('idle', 'linger-elapsed')).toBe('idle');
    expect(nextIndicatorState('visible', 'delay-elapsed')).toBe('visible');
    expect(nextIndicatorState('pending', 'linger-elapsed')).toBe('pending');
  });

  it('is total — every state/event pair yields a known state', () => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        expect(STATES).toContain(nextIndicatorState(state, event));
      }
    }
  });

  it('only ever renders in the two on-screen states', () => {
    expect(STATES.filter(isIndicatorVisible)).toEqual(['visible', 'lingering']);
  });

  it('keeps the linger longer than the delay, so a shown bar is always perceptible', () => {
    expect(MIN_VISIBLE_MS).toBeGreaterThan(SHOW_DELAY_MS);
  });

  it('sets the watchdog far past any real request, so a healthy one is never cut short', () => {
    expect(MAX_VISIBLE_MS).toBeGreaterThan(MIN_VISIBLE_MS + SHOW_DELAY_MS);
  });

  it('outlasts the deadline the app itself gives a request, so a live one keeps the bar', () => {
    // The two numbers are set in different modules and neither imports the
    // other, so nothing but this assertion keeps them ordered. Below the
    // deadline the watchdog gives up on work the app is still waiting for, and
    // the no-resurrect rule means the bar never returns when the answer does.
    expect(MAX_VISIBLE_MS).toBeGreaterThan(REST_TIMEOUT_MS);
  });
});
