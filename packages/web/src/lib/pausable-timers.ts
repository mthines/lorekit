/**
 * A set of `setTimeout`-backed waits that can be suspended and resumed as a
 * group, each keeping the time it had left.
 *
 * ## Why this exists
 *
 * `TerminalTheater` plays a script as a sequence of `await wait(ms)` calls. To
 * stop it burning the main thread while it is scrolled off screen, the loop has
 * to stop somewhere — and the only two ways to stop an `await` are to cancel it
 * (which restarts the script when playback resumes, losing the visitor's place
 * mid-sentence) or to freeze it. This freezes it: a wait interrupted with 200ms
 * remaining resumes as a 200ms wait, so the script continues from exactly where
 * it left off.
 *
 * ## Contract
 *
 * - `wait(ms)` resolves after `ms` of UNPAUSED time.
 * - `pause()` and `resume()` are idempotent; pausing while already paused, or
 *   resuming while already running, does nothing.
 * - A wait started while paused does not begin counting until `resume()`.
 * - `cancel()` clears every pending timer and RESOLVES the promises. It does
 *   not reject: the caller is an async loop that checks its own cancellation
 *   flag after each `await`, so a settled promise is what lets it unwind and
 *   return. A rejection would need a `try`/`catch` around every step and an
 *   unhandled rejection on any that was missed.
 *
 * The clock and scheduler are injected so the behaviour is testable without
 * real time passing.
 */

/** Injectable environment, so tests can drive the clock by hand. */
export interface TimerEnvironment {
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  unschedule: (handle: unknown) => void;
}

const REAL_ENVIRONMENT: TimerEnvironment = {
  now: () => Date.now(),
  schedule: (fn, ms) => setTimeout(fn, ms),
  unschedule: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PausableTimers {
  /** Resolves after `ms` of unpaused time. */
  wait: (ms: number) => Promise<void>;
  /** Freeze every pending wait, each keeping its remaining time. */
  pause: () => void;
  /** Restart every pending wait from the time it had left. */
  resume: () => void;
  /** Clear every pending timer and resolve its promise. */
  cancel: () => void;
  /** Whether waits are currently frozen. */
  isPaused: () => boolean;
}

interface PendingWait {
  resolve: () => void;
  /** Time left to wait, refreshed on each pause. */
  remaining: number;
  /** When the current run of this wait began; `null` while paused. */
  startedAt: number | null;
  handle: unknown;
}

/**
 * Create a group of pausable waits.
 *
 * @param startPaused begin frozen, so a caller that is already off screen on
 *   first render does not have to race an effect to stop the first wait.
 * @param env injectable clock and scheduler; defaults to real timers.
 */
export function createPausableTimers(
  startPaused = false,
  env: TimerEnvironment = REAL_ENVIRONMENT,
): PausableTimers {
  let paused = startPaused;
  const pending = new Set<PendingWait>();

  function start(entry: PendingWait): void {
    entry.startedAt = env.now();
    entry.handle = env.schedule(() => {
      pending.delete(entry);
      entry.resolve();
    }, entry.remaining);
  }

  return {
    wait(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const entry: PendingWait = {
          resolve,
          // A non-positive wait is still a wait: it must not resolve
          // synchronously, or a paused caller would run the whole script in one
          // tick. Clamp to zero and let the scheduler settle it.
          remaining: Math.max(0, ms),
          startedAt: null,
          handle: undefined,
        };
        pending.add(entry);
        if (!paused) start(entry);
      });
    },

    pause(): void {
      if (paused) return;
      paused = true;
      const at = env.now();
      for (const entry of pending) {
        env.unschedule(entry.handle);
        entry.handle = undefined;
        if (entry.startedAt !== null) {
          entry.remaining = Math.max(0, entry.remaining - (at - entry.startedAt));
          entry.startedAt = null;
        }
      }
    },

    resume(): void {
      if (!paused) return;
      paused = false;
      for (const entry of pending) start(entry);
    },

    cancel(): void {
      // Copied before iterating: `resolve` hands control back to the awaiting
      // loop, which may call `wait` again and mutate the set mid-iteration.
      const entries = [...pending];
      pending.clear();
      for (const entry of entries) {
        env.unschedule(entry.handle);
        entry.resolve();
      }
    },

    isPaused: () => paused,
  };
}
