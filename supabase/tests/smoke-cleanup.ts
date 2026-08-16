/**
 * Smoke-test cleanup — shared naming + sweep helpers for the LIVE suites.
 * -----------------------------------------------------------------------
 * The integration smoke suites (`smoke.integration`, `memories-api.integration`,
 * `orgs-api.integration`, `byod-smoke.integration`) run against REAL projects —
 * the hosted staging/preview project in `deploy.yml`, and whatever endpoint a
 * developer points them at. Every row they write is a row in someone's tenant,
 * so a run that does not remove its own artefacts pollutes that database
 * permanently.
 *
 * Two failure modes had to be closed, and they need different mechanisms:
 *
 *  1. **The suite finished but did not clean up completely.** Cleanup used to
 *     be a hand-maintained list of ids captured mid-test, so a key created by a
 *     test that FAILED before its `createdId… =` assignment was never recorded
 *     and never deleted — and the MCP suite's cleanup soft-ARCHIVED rather than
 *     deleting, so its rows survived every run by design. The fix is
 *     `createSmokeNamespace`: every key/slug a suite uses is minted through it,
 *     which registers it at mint time (not at assertion time), so `afterAll` can
 *     hard-delete the complete set no matter which test threw.
 *
 *  2. **The process never reached `afterAll` at all** — a crash, an OOM, a
 *     cancelled workflow, a 6h job timeout. No in-process hook can cover that,
 *     so `scripts/smoke-cleanup.mjs` sweeps leftovers from PREVIOUS runs by
 *     matching this module's artefact pattern. That script is standalone
 *     (zero-dep `.mjs`, runnable as an `if: always()` CI step), so the pattern
 *     is mirrored there and `smoke-cleanup.spec.ts` guards the two against
 *     drift — the `limits.ts` mirror pattern.
 *
 * Everything here is deliberately transport-agnostic: the MCP suite speaks
 * JSON-RPC and the REST suites speak HTTP, so the sweep takes its I/O injected
 * rather than reaching for a client of its own.
 */

/**
 * Matches the timestamped artefact names every live smoke suite mints:
 * `smoke-1717171717171-a`, `memories-smoke-1717171717171-restore`,
 * `byod-smoke-1717171717171-global`, `smoke-1717171717171-tok` (an org slug).
 *
 * The label alternation is a CLOSED SET (`memories-` / `byod-` / `embed-` /
 * bare), not a generic `[a-z0-9-]*` prefix. A permissive prefix also matches
 * real lore such as `how-to-debug-a-smoke-1717171717171-failure`, and the
 * consumer of this pattern DELETES what it matches — so the set of recognised
 * labels is enumerated here and `createSmokeNamespace` refuses to mint outside
 * it. Adding a suite is a deliberate edit in one place, not an accident.
 *
 * The `\d{10,}` group is `Date.now()` — a millisecond epoch, so it is 13 digits
 * today and stays matched when it grows. It is a CAPTURE group because the
 * standalone sweeper reads the mint time out of the name: an orphan can only be
 * distinguished from a run that is still in flight by its age.
 *
 * MIRROR: `scripts/smoke-cleanup.mjs` carries a verbatim copy (it is a zero-dep
 * standalone script and cannot import this module). `smoke-cleanup.spec.ts`
 * fails if the two diverge.
 */
export const SMOKE_ARTEFACT_PATTERN = /^(?:memories-|byod-|embed-)?smoke-(\d{10,})(?:-[a-z0-9-]*)?$/;

/**
 * The mint time encoded in a smoke artefact name, or `null` when the name was
 * not minted by a smoke suite. Total function — never throws, so a caller can
 * run it over every key in a tenant.
 */
export function smokeArtefactTimestamp(name: string): number | null {
  const m = SMOKE_ARTEFACT_PATTERN.exec(name);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Age of an artefact derived from its NAME alone.
 *
 * This is the FALLBACK rule. The sweeper prefers the server's `updated_at` /
 * `created_at`, because the name's epoch is minted by `Date.now()` on whatever
 * machine ran the suite: a runner with a slow clock would otherwise mint names
 * that look already-stale and have its live rows deleted mid-run. The name stays
 * the authority on RECOGNITION (see {@link smokeArtefactTimestamp}); it is only
 * consulted for AGE when a row carries no server timestamp.
 *
 * `-Infinity` for an unrecognised name, so it can never clear a threshold. A
 * future-dated name yields a negative age and is likewise never swept — a
 * runner whose clock ran fast must not have its live rows treated as orphans.
 *
 * The caller compares this against its own `minAgeMs`, which is the guard that
 * keeps two legitimately-overlapping smoke runs (a preview deploy and a
 * developer's local run against the same project) from sweeping each other's
 * working set mid-suite.
 */
export function smokeArtefactAgeMs(name: string, now: number): number {
  const mintedAt = smokeArtefactTimestamp(name);
  return mintedAt === null ? -Infinity : now - mintedAt;
}


/**
 * A suite's artefact namespace. Every key or slug the suite uses is minted here
 * so the cleanup set is derived from what was ACTUALLY minted, never from a
 * hand-maintained list that silently falls behind the tests.
 */
export interface SmokeNamespace {
  /** The shared `<label>-<epoch-ms>` prefix. Unique per run. */
  readonly prefix: string;
  /** Mint (and register) `${prefix}-${suffix}`. Idempotent for a given suffix. */
  name(suffix: string): string;
  /** Every name minted so far, in mint order. */
  minted(): string[];
}

/**
 * Create a namespace whose names match {@link SMOKE_ARTEFACT_PATTERN} — both the
 * label (here) and every suffix (in `name`).
 *
 * Throws on a label the pattern does not admit. That is the point: a suite that
 * mints unrecognised names is a suite the orphan sweeper silently ignores, and
 * a leak with no signal is the exact failure this module was written to end. A
 * new label is a two-line edit (here and in the mirrored pattern), enforced at
 * the first call rather than discovered months later as accumulated rows.
 */
export function createSmokeNamespace(label: string, now: number = Date.now()): SmokeNamespace {
  const prefix = label === 'smoke' ? `smoke-${now}` : `${label}-smoke-${now}`;
  if (!SMOKE_ARTEFACT_PATTERN.test(prefix)) {
    throw new Error(
      `smoke label "${label}" produces "${prefix}", which SMOKE_ARTEFACT_PATTERN does not match — ` +
        'the orphan sweeper would never clean it up. Add the label to the pattern ' +
        '(supabase/tests/smoke-cleanup.ts AND scripts/smoke-cleanup.mjs) first.',
    );
  }
  const minted: string[] = [];
  return {
    prefix,
    name(suffix: string): string {
      const full = `${prefix}-${suffix}`;
      // The FULL name, not just the prefix. The pattern constrains the suffix to
      // `[a-z0-9-]`, so an underscore, a dot, a colon or any uppercase letter
      // mints a name the orphan sweeper will never recognise — the same silent
      // leak the label check above exists to prevent, one level down.
      if (!SMOKE_ARTEFACT_PATTERN.test(full)) {
        throw new Error(
          `smoke suffix "${suffix}" produces "${full}", which SMOKE_ARTEFACT_PATTERN does not match — ` +
            'the orphan sweeper would never clean it up. Suffixes are lowercase [a-z0-9-].',
        );
      }
      if (!minted.includes(full)) minted.push(full);
      return full;
    },
    minted(): string[] {
      return [...minted];
    },
  };
}

/** How a suite removes one artefact. Must HARD-delete — an archive still occupies a row. */
export type HardDelete = (name: string) => Promise<void>;

export interface SweepReport {
  /** Names the sweep removed (or confirmed absent) without error. */
  removed: string[];
  /** Names the sweep could not remove, with the reason, for the log. */
  failed: Array<{ name: string; reason: string }>;
}

/**
 * The most deletes a sweep runs at once. Bounded on purpose: parallel enough
 * that a namespace of a dozen-plus keys sweeps in a couple of round-trips
 * instead of one-DELETE-per-key at hosted latency (which pushed the `afterAll`
 * hook past its timeout and failed a deploy on cleanup alone), yet small enough
 * that a burst can never approach the per-user rate limit (120 req/min). The
 * spec asserts the cap, so raising it is a deliberate edit.
 */
export const SWEEP_CONCURRENCY = 5;

/**
 * Hard-delete every minted name, never throwing.
 *
 * Cleanup runs in `afterAll`, where a throw would turn "the suite passed but a
 * row leaked" into "the suite failed", masking the real result. So failures are
 * COLLECTED and returned for the caller to log loudly — a leak must be visible,
 * but it must not be reported as a test failure it is not.
 *
 * Deletions run with BOUNDED concurrency ({@link SWEEP_CONCURRENCY}) — fast
 * enough that the teardown never approaches the hook timeout, capped so it never
 * bursts past the live endpoint's rate limit. The report preserves INPUT order
 * regardless of completion order, so callers and tests stay stable.
 */
export async function sweepSmokeArtefacts(
  names: readonly string[],
  hardDelete: HardDelete,
): Promise<SweepReport> {
  // Slot i holds name i's outcome, so the report is assembled in input order
  // no matter which worker finishes first. `cursor++` hands each worker the
  // next index — safe without a lock because there is no await between the read
  // and the increment (JS runs this synchronously).
  const results = new Array<{ name: string; ok: boolean; reason?: string }>(names.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (let i = cursor++; i < names.length; i = cursor++) {
      const name = names[i];
      try {
        await hardDelete(name);
        results[i] = { name, ok: true };
      } catch (err) {
        results[i] = { name, ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  const workers = Math.min(SWEEP_CONCURRENCY, names.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  const report: SweepReport = { removed: [], failed: [] };
  for (const r of results) {
    if (r.ok) report.removed.push(r.name);
    else report.failed.push({ name: r.name, reason: r.reason ?? 'unknown' });
  }
  return report;
}

/**
 * Run a best-effort cleanup step that can NEVER fail the suite.
 *
 * A teardown sweep is not a test: if it is slow or errors, the run must still
 * report the truth about what was under test. This races the cleanup against a
 * soft timeout set well under vitest's hook ceiling — if cleanup overruns, it
 * warns and returns (the always-on `scripts/smoke-cleanup.mjs` sweep removes
 * whatever was left); if it throws, that is swallowed with a warning too. Either
 * way the returned promise resolves, so the enclosing `afterAll` can neither
 * time out nor reject on cleanup alone.
 */
export async function runBestEffortCleanup(
  fn: () => Promise<void>,
  opts: { softTimeoutMs: number; context: string },
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `\n  ⚠ SMOKE CLEANUP TIMED OUT (${opts.context}) after ${opts.softTimeoutMs}ms — ` +
          'leaving the rest to `scripts/smoke-cleanup.mjs`.',
      );
      resolve();
    }, opts.softTimeoutMs);
    // Don't let a pending guard timer keep the process alive after teardown.
    if (typeof timer.unref === 'function') timer.unref();
  });
  // `Promise.resolve().then(fn)` — NOT `fn().catch(...)` — so a SYNCHRONOUS throw
  // inside fn becomes a rejection this `.catch` handles, instead of propagating
  // out before the handler is attached (which would reject this function and skip
  // the `finally`, leaking the timer — the exact thing the docblock rules out).
  const attempt = Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.warn(
        `\n  ⚠ SMOKE CLEANUP ERRORED (${opts.context}) — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  try {
    await Promise.race([attempt, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Render a sweep report as a single warning line, or `null` when it was clean.
 *
 * Returning `null` for the clean case keeps the call site a one-liner while
 * guaranteeing that a leak is never silent: whatever is left behind is named in
 * the CI log, which is the only place a human will ever see it.
 */
export function describeSweepFailures(
  report: SweepReport,
  context: string,
  opts: { sweeperCovers?: boolean } = {},
): string | null {
  if (report.failed.length === 0) return null;
  const lines = report.failed.map((f) => `      - ${f.name}: ${f.reason}`).join('\n');
  // Only promise the sweeper where it can actually reach. It targets
  // `LOREKIT_REST_BASE_URL`, so a BYOD leftover — a different project, over MCP
  // — is NOT covered, and telling a reader otherwise turns a visible leak into
  // one they believe is already handled.
  const followUp =
    opts.sweeperCovers === false
      ? '    Nothing else will remove them: this suite writes to its own project, which\n' +
        '    `scripts/smoke-cleanup.mjs` does not target. Delete them by hand.\n'
      : '    They will be removed by the next `node scripts/smoke-cleanup.mjs` sweep.\n';
  return (
    `\n  ⚠ SMOKE CLEANUP INCOMPLETE (${context}) — ${report.failed.length} artefact(s) were left behind:\n` +
    `${lines}\n` +
    followUp
  );
}
