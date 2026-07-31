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
 * The label alternation is a CLOSED SET (`memories-` / `byod-` / bare), not a
 * generic `[a-z0-9-]*` prefix. A permissive prefix also matches real lore such
 * as `how-to-debug-a-smoke-1717171717171-failure`, and the consumer of this
 * pattern DELETES what it matches — so the set of recognised labels is
 * enumerated here and `createSmokeNamespace` refuses to mint outside it. Adding
 * a suite is a deliberate edit in one place, not an accident.
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
export const SMOKE_ARTEFACT_PATTERN = /^(?:memories-|byod-)?smoke-(\d{10,})(?:-[a-z0-9-]*)?$/;

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
 * Is `name` a smoke artefact old enough to be an ORPHAN rather than the working
 * set of a run that is still in flight?
 *
 * `minAgeMs` is the load-bearing guard: two smoke runs can legitimately overlap
 * (a preview deploy and a developer's local run against the same project), and
 * sweeping by pattern alone would have one delete the other's rows mid-suite.
 */
export function isStaleSmokeArtefact(
  name: string,
  opts: { now: number; minAgeMs: number },
): boolean {
  const mintedAt = smokeArtefactTimestamp(name);
  if (mintedAt === null) return false;
  // A future-dated name yields a negative age, which fails the comparison for
  // any non-negative `minAgeMs` — so a clock-skewed runner cannot make the
  // sweeper treat a live run's rows as orphans. Written as a subtraction rather
  // than a special case because that is the same arithmetic the mirrored
  // sweeper does.
  return opts.now - mintedAt >= opts.minAgeMs;
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
 * Create a namespace whose names match {@link SMOKE_ARTEFACT_PATTERN}.
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
        '(packages/mcp-server/src/smoke-cleanup.ts AND scripts/smoke-cleanup.mjs) first.',
    );
  }
  const minted: string[] = [];
  return {
    prefix,
    name(suffix: string): string {
      const full = `${prefix}-${suffix}`;
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
 * Hard-delete every minted name, never throwing.
 *
 * Cleanup runs in `afterAll`, where a throw would turn "the suite passed but a
 * row leaked" into "the suite failed", masking the real result. So failures are
 * COLLECTED and returned for the caller to log loudly — a leak must be visible,
 * but it must not be reported as a test failure it is not.
 *
 * Deletions are sequential on purpose: these run against a live endpoint with a
 * per-user rate limit (120 req/min), and a burst of parallel deletes from a
 * cleanup hook is the last thing that should trip it.
 */
export async function sweepSmokeArtefacts(
  names: readonly string[],
  hardDelete: HardDelete,
): Promise<SweepReport> {
  const report: SweepReport = { removed: [], failed: [] };
  for (const name of names) {
    try {
      await hardDelete(name);
      report.removed.push(name);
    } catch (err) {
      report.failed.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/**
 * Render a sweep report as a single warning line, or `null` when it was clean.
 *
 * Returning `null` for the clean case keeps the call site a one-liner while
 * guaranteeing that a leak is never silent: whatever is left behind is named in
 * the CI log, which is the only place a human will ever see it.
 */
export function describeSweepFailures(report: SweepReport, context: string): string | null {
  if (report.failed.length === 0) return null;
  const lines = report.failed.map((f) => `      - ${f.name}: ${f.reason}`).join('\n');
  return (
    `\n  ⚠ SMOKE CLEANUP INCOMPLETE (${context}) — ${report.failed.length} artefact(s) were left behind:\n` +
    `${lines}\n` +
    '    They will be removed by the next `node scripts/smoke-cleanup.mjs` sweep.\n'
  );
}
