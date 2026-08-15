// Client-side rate-limit handling for a bulk REST push (`migrate --to remote`).
//
// The hosted API allows 120 requests/min/user (docs/limits.md), enforced by a
// Postgres fixed-window counter. A migration is the one CLI flow that can
// exceed that on its own: it issues up to two requests per entry (a read to
// classify, a write to apply), so a few hundred lessons blow the window in
// seconds. Two independent guards, because either alone is wrong:
//
//   `createPacer`  — PROACTIVE. Keeps the client under a self-imposed ceiling
//                    below the server's, so a normal run never trips the limit
//                    and never pays a retry.
//   `withRetry`    — REACTIVE. The ceiling is a guess (the limit is per USER,
//                    not per process — a concurrent agent shares it, and a
//                    per-user override can move it), so a 429 must still be
//                    survivable rather than a failed migration.
//
// Both take their clock and sleep as parameters, so the tests are instant and
// deterministic rather than actually waiting out a window.
//
// Zero-dependency.

export const DEFAULT_MAX_PER_WINDOW = 100; // under the 120/min server limit
export const WINDOW_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 60_000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * A sliding-window pacer: `await pace()` before each request.
 *
 * Returns immediately while fewer than `maxPerWindow` requests were issued in
 * the last `windowMs`; otherwise waits exactly until the oldest one falls out
 * of the window. A small migration therefore runs at full speed and pays
 * nothing for this, and a large one self-throttles instead of being throttled.
 */
export function createPacer({
  maxPerWindow = DEFAULT_MAX_PER_WINDOW,
  windowMs = WINDOW_MS,
  now = () => Date.now(),
  sleepFn = sleep,
} = {}) {
  const issued = [];
  return async function pace() {
    for (;;) {
      const cutoff = now() - windowMs;
      while (issued.length && issued[0] <= cutoff) issued.shift();
      if (issued.length < maxPerWindow) {
        issued.push(now());
        return;
      }
      // Wait out the oldest request, then re-check: the clock moved, so the
      // window has to be re-evaluated rather than assumed clear.
      await sleepFn(issued[0] + windowMs - now() + 1);
    }
  };
}

/**
 * Whether a store result is a retryable rate-limit rejection.
 *
 * `memory_cap` is the reason this is a function and not a status comparison:
 * the memory-cap trigger (LK001) is ALSO translated to HTTP 429
 * (supabase/functions/_shared/api/errors.ts), and it is terminal — retrying it
 * just burns the user's rate budget on a write that can never succeed.
 */
export function isRateLimited(res) {
  return Boolean(res && res.httpStatus === 429 && res.error?.code !== 'memory_cap');
}

/**
 * Whether a store result is worth trying again at all.
 *
 * Wider than `isRateLimited` on purpose. This module exists for a BULK push of
 * potentially thousands of requests, which is precisely the shape of run where
 * a single transient 5xx or a dropped connection is likeliest — and failing
 * one entry out of two thousand for a blip the next attempt would sail through
 * is a bad trade. So a 5xx and a transport error retry too.
 *
 * What does NOT retry is anything the server has decided: a 4xx is a rejection
 * (bad scope, denied permission), and `memory_cap` is terminal even though it
 * arrives as a 429. Retrying either just burns the user's rate budget.
 */
export function isRetryable(res) {
  if (!res || isMemoryCap(res)) return false;
  if (res.networkError) return true;
  if (isRateLimited(res)) return true;
  return typeof res.httpStatus === 'number' && res.httpStatus >= 500;
}

/** Whether a store result is the terminal memory-cap rejection. */
export function isMemoryCap(res) {
  return Boolean(res && res.error?.code === 'memory_cap');
}

/**
 * Run `fn` and retry it while it comes back retryable (see `isRetryable`).
 *
 * Honours the server's own `Retry-After` when it sent one — it knows when its
 * window rolls over and the client does not — and falls back to exponential
 * backoff otherwise. Returns the last result once the attempts are spent, so
 * the caller reports a real error rather than a synthesised one; `onRetry` is
 * for progress output.
 */
export async function withRetry(fn, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleepFn = sleep,
  onRetry = null,
} = {}) {
  let res;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A read reports a rate limit by THROWING (`RemoteStore.getEntry` refuses
    // to let a failed read look like an absence), so the rejection has to be
    // classified here too — otherwise only writes would ever be retried and a
    // 429 on the classifying read would fail the entry outright. Anything that
    // is not a rate limit propagates untouched.
    try {
      res = await fn();
    } catch (e) {
      if (!isRetryable(e?.result) || attempt === maxAttempts) throw e;
      await sleepFn(retryDelay(e.result, attempt, baseDelayMs, onRetry));
      continue;
    }
    if (!isRetryable(res) || attempt === maxAttempts) return res;
    await sleepFn(retryDelay(res, attempt, baseDelayMs, onRetry));
  }
  return res;
}

// How long to wait before the next attempt: the server's own hint when it sent
// one — it knows when its window rolls over and the client does not — else
// exponential backoff. Shared by the resolved and the thrown path so the two
// cannot drift.
function retryDelay(res, attempt, baseDelayMs, onRetry) {
  const hinted = Number(res?.retryAfter);
  const delayMs = Number.isFinite(hinted) && hinted > 0
    ? Math.min(hinted * 1000, MAX_RETRY_DELAY_MS)
    : Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  if (onRetry) onRetry({ attempt, delayMs });
  return delayMs;
}
