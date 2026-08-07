import { describe, expect, it } from 'vitest';

import { createPausableTimers, type TimerEnvironment } from './pausable-timers';

/**
 * A hand-driven clock and scheduler. `advance(ms)` moves time forward and fires
 * every timer whose deadline has passed, so a test can assert on remaining time
 * rather than on wall-clock behaviour.
 */
function fakeEnvironment() {
  let current = 0;
  let nextHandle = 1;
  const scheduled = new Map<number, { fn: () => void; dueAt: number }>();

  const env: TimerEnvironment = {
    now: () => current,
    schedule: (fn, ms) => {
      const handle = nextHandle++;
      scheduled.set(handle, { fn, dueAt: current + ms });
      return handle;
    },
    unschedule: (handle) => {
      scheduled.delete(handle as number);
    },
  };

  function advance(ms: number): void {
    current += ms;
    for (const [handle, entry] of [...scheduled]) {
      if (entry.dueAt <= current) {
        scheduled.delete(handle);
        entry.fn();
      }
    }
  }

  return { env, advance, pendingCount: () => scheduled.size };
}

/** Resolve after the microtask queue drains, so a settled promise is observable. */
const flush = () => Promise.resolve();

describe('createPausableTimers', () => {
  it('resolves a wait once the full duration has elapsed', async () => {
    const { env, advance } = fakeEnvironment();
    const timers = createPausableTimers(false, env);

    let done = false;
    void timers.wait(100).then(() => {
      done = true;
    });

    advance(99);
    await flush();
    expect(done).toBe(false);

    advance(1);
    await flush();
    expect(done).toBe(true);
  });

  it('resumes a paused wait with only the time that was left', async () => {
    const { env, advance } = fakeEnvironment();
    const timers = createPausableTimers(false, env);

    let done = false;
    void timers.wait(100).then(() => {
      done = true;
    });

    advance(30);
    timers.pause();

    // An hour off screen must not consume any of the remaining 70ms.
    advance(3_600_000);
    await flush();
    expect(done).toBe(false);

    timers.resume();
    advance(69);
    await flush();
    expect(done).toBe(false);

    advance(1);
    await flush();
    expect(done).toBe(true);
  });

  it('does not start a wait created while paused', async () => {
    const { env, advance } = fakeEnvironment();
    const timers = createPausableTimers(true, env);

    let done = false;
    void timers.wait(50).then(() => {
      done = true;
    });

    advance(1000);
    await flush();
    expect(done).toBe(false);

    timers.resume();
    advance(50);
    await flush();
    expect(done).toBe(true);
  });

  it('is idempotent across repeated pause and resume calls', async () => {
    const { env, advance } = fakeEnvironment();
    const timers = createPausableTimers(false, env);

    let done = false;
    void timers.wait(100).then(() => {
      done = true;
    });

    advance(40);
    timers.pause();
    timers.pause();
    expect(timers.isPaused()).toBe(true);

    timers.resume();
    timers.resume();
    expect(timers.isPaused()).toBe(false);

    // A second pause must not have re-subtracted the elapsed 40ms.
    advance(59);
    await flush();
    expect(done).toBe(false);

    advance(1);
    await flush();
    expect(done).toBe(true);
  });

  it('pauses several waits independently', async () => {
    const { env, advance } = fakeEnvironment();
    const timers = createPausableTimers(false, env);

    const settled: string[] = [];
    void timers.wait(100).then(() => settled.push('long'));
    advance(50);
    void timers.wait(20).then(() => settled.push('short'));

    advance(10);
    timers.pause();
    timers.resume();

    advance(10);
    await flush();
    expect(settled).toEqual(['short']);

    advance(30);
    await flush();
    expect(settled).toEqual(['short', 'long']);
  });

  it('resolves rather than rejects on cancel, and clears the timers', async () => {
    const { env, advance, pendingCount } = fakeEnvironment();
    const timers = createPausableTimers(false, env);

    let done = false;
    void timers.wait(100).then(() => {
      done = true;
    });

    timers.cancel();
    await flush();
    expect(done).toBe(true);
    expect(pendingCount()).toBe(0);

    // The cancelled timer must not fire a second time.
    advance(100);
    await flush();
    expect(pendingCount()).toBe(0);
  });

  it('cancels waits that were created while paused', async () => {
    const { env } = fakeEnvironment();
    const timers = createPausableTimers(true, env);

    let done = false;
    void timers.wait(100).then(() => {
      done = true;
    });

    timers.cancel();
    await flush();
    expect(done).toBe(true);
  });

  it('does not resolve a zero-length wait synchronously', async () => {
    const { env, advance } = fakeEnvironment();
    const timers = createPausableTimers(true, env);

    let done = false;
    void timers.wait(0).then(() => {
      done = true;
    });

    // Still paused: a zero wait is a wait, or a paused script would run to
    // completion in a single tick.
    await flush();
    expect(done).toBe(false);

    timers.resume();
    advance(0);
    await flush();
    expect(done).toBe(true);
  });
});
