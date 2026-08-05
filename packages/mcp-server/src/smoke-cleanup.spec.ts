/**
 * Unit tests for the smoke-cleanup helpers.
 *
 * These are pure/injected on purpose — the behaviour that matters (a suite
 * cleans up EVERY artefact it minted, even the ones whose tests threw) is
 * exactly what a live run cannot demonstrate without polluting a real project.
 *
 * The last test is a drift guard: `scripts/smoke-cleanup.mjs` carries a verbatim
 * copy of the artefact pattern because it must run zero-dependency from a bare
 * checkout. A silent divergence there means the sweeper stops recognising the
 * very names the suites mint — the failure mode is a slow leak with no signal,
 * so it is asserted mechanically.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SMOKE_ARTEFACT_PATTERN,
  createSmokeNamespace,
  describeSweepFailures,
  runBestEffortCleanup,
  SWEEP_CONCURRENCY,
  smokeArtefactAgeMs,
  smokeArtefactTimestamp,
  sweepSmokeArtefacts,
} from './smoke-cleanup.js';

const MINUTE = 60_000;

describe('SMOKE_ARTEFACT_PATTERN / smokeArtefactTimestamp', () => {
  it.each([
    ['smoke-1717171717171-a', 1717171717171],
    ['smoke-1717171717171', 1717171717171],
    ['memories-smoke-1717171717171-restore', 1717171717171],
    ['byod-smoke-1717171717171-global', 1717171717171],
    ['smoke-1717171717171-org-id-form', 1717171717171],
    ['smoke-1717171717171-tok', 1717171717171],
  ])('recognises %s', (name, expected) => {
    expect(smokeArtefactTimestamp(name)).toBe(expected);
  });

  it.each([
    // Real lore that merely mentions smoke — the anchors are what protect it.
    'how-to-debug-a-smoke-1717171717171-failure',
    'notes-about-smoke-tests',
    'smoke',
    'smoke-abc-a',
    // A label outside the closed set — an unknown suite must not be swept by
    // accident, and must fail loudly at mint time instead (see below).
    'orgs-smoke-1717171717171-a',
    // Too few digits to be a millisecond epoch: not a name this repo mints.
    'smoke-1717-a',
    // Uppercase / punctuation outside the minted charset.
    'Smoke-1717171717171-a',
    'smoke-1717171717171-a/b',
    '',
  ])('does not recognise %s', (name) => {
    expect(smokeArtefactTimestamp(name)).toBeNull();
  });
});

describe('smokeArtefactAgeMs', () => {
  it('is -Infinity for a name it does not recognise, so no threshold can clear it', () => {
    expect(smokeArtefactAgeMs('a-real-lesson', Date.now())).toBe(-Infinity);
  });

  it('is negative for a future-dated name', () => {
    const minted = 1_700_000_000_000;
    expect(smokeArtefactAgeMs(`smoke-${minted}-a`, minted - 60_000)).toBe(-60_000);
  });
});

describe('the age guard (smokeArtefactAgeMs + the caller\'s minAgeMs)', () => {
  const minted = 1_700_000_000_000;
  const name = `smoke-${minted}-a`;
  const stale = (now: number, minAgeMs: number) => smokeArtefactAgeMs(name, now) >= minAgeMs;

  it('leaves an artefact younger than the age guard alone', () => {
    // The load-bearing case: a concurrent run's rows must survive the sweep.
    expect(stale(minted + 5 * MINUTE, 30 * MINUTE)).toBe(false);
  });

  it('sweeps an artefact at or beyond the age guard', () => {
    expect(stale(minted + 30 * MINUTE, 30 * MINUTE)).toBe(true);
    expect(stale(minted + 99 * MINUTE, 30 * MINUTE)).toBe(true);
  });

  it('never sweeps a name it does not recognise, however old', () => {
    expect(smokeArtefactAgeMs('a-real-lesson', Number.MAX_SAFE_INTEGER) >= 0).toBe(false);
  });

  it('leaves a future-dated artefact alone (a skewed clock must not delete live rows)', () => {
    expect(stale(minted - MINUTE, 0)).toBe(false);
  });
});

describe('createSmokeNamespace', () => {
  it('mints names that the sweeper pattern recognises', () => {
    const ns = createSmokeNamespace('memories', 1_700_000_000_000);
    expect(ns.prefix).toBe('memories-smoke-1700000000000');
    expect(ns.name('restore')).toBe('memories-smoke-1700000000000-restore');
    expect(SMOKE_ARTEFACT_PATTERN.test(ns.name('restore'))).toBe(true);
  });

  it('does not double up the label when it is already "smoke" (org slugs)', () => {
    const ns = createSmokeNamespace('smoke', 1_700_000_000_000);
    expect(ns.name('tok')).toBe('smoke-1700000000000-tok');
  });

  it('registers every minted name once, in mint order', () => {
    const ns = createSmokeNamespace('smoke', 1_700_000_000_000);
    ns.name('a');
    ns.name('b');
    ns.name('a');
    expect(ns.minted()).toEqual(['smoke-1700000000000-a', 'smoke-1700000000000-b']);
  });

  it('refuses a label the sweeper pattern would not recognise', () => {
    // Fail at the first call, not as silent accumulation in a live project.
    expect(() => createSmokeNamespace('orgs')).toThrow(/SMOKE_ARTEFACT_PATTERN/);
  });

  it('refuses a SUFFIX the pattern would not recognise', () => {
    // Same failure one level down: the label can be valid and the minted name
    // still unrecognisable, which is a leak the sweeper can never clean up.
    const ns = createSmokeNamespace('smoke', 1_700_000_000_000);
    for (const bad of ['Upper', 'has_underscore', 'has.dot', 'has:colon', 'has space']) {
      expect(() => ns.name(bad), bad).toThrow(/SMOKE_ARTEFACT_PATTERN/);
    }
    expect(ns.minted(), 'a refused suffix must not be registered').toEqual([]);
  });

  it('registers at MINT time, which is what makes cleanup failure-proof', () => {
    // The regression this whole module exists for: a key created by a test that
    // threw before recording its id was never cleaned up. Minting is the only
    // event cleanup may depend on.
    const ns = createSmokeNamespace('smoke', 1_700_000_000_000);
    const key = ns.name('created-then-the-test-threw');
    expect(ns.minted()).toContain(key);
  });
});

describe('sweepSmokeArtefacts', () => {
  it('deletes every name and reports them, in input order', async () => {
    const seen: string[] = [];
    const report = await sweepSmokeArtefacts(['a', 'b', 'c'], async (n) => { seen.push(n); });
    // Every name is deleted; the report preserves INPUT order regardless of the
    // (now concurrent) completion order.
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect(report.removed).toEqual(['a', 'b', 'c']);
    expect(report.failed).toEqual([]);
  });

  it('keeps going after a failure and never throws, preserving order', async () => {
    // A cleanup hook that throws turns "one row leaked" into "the suite failed",
    // masking the real result — and stops the remaining artefacts being removed.
    const report = await sweepSmokeArtefacts(['a', 'b', 'c'], async (n) => {
      if (n === 'b') throw new Error('HTTP 500');
    });
    expect(report.removed).toEqual(['a', 'c']);
    expect(report.failed).toEqual([{ name: 'b', reason: 'HTTP 500' }]);
  });

  it('deletes with bounded concurrency, so a burst cannot trip the rate limit', async () => {
    // Parallel enough to beat the hook timeout at hosted latency, capped at
    // SWEEP_CONCURRENCY so a cleanup burst never approaches 120 req/min. With
    // more names than the cap, in-flight peaks AT the cap and never above it.
    const names = Array.from({ length: SWEEP_CONCURRENCY * 2 }, (_, i) => `k${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    await sweepSmokeArtefacts(names, async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent
    expect(maxInFlight).toBeLessThanOrEqual(SWEEP_CONCURRENCY); // never a burst
  });
});

describe('runBestEffortCleanup', () => {
  it('resolves normally when cleanup finishes in time', async () => {
    let ran = false;
    await expect(
      runBestEffortCleanup(async () => { ran = true; }, { softTimeoutMs: 1000, context: 'ctx' }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });

  it('resolves (never rejects) when cleanup throws asynchronously', async () => {
    await expect(
      runBestEffortCleanup(async () => { throw new Error('boom'); }, { softTimeoutMs: 1000, context: 'ctx' }),
    ).resolves.toBeUndefined();
  });

  it('resolves (never rejects) when cleanup throws SYNCHRONOUSLY', async () => {
    // A non-async fn that throws before returning a promise must still be caught:
    // `fn()` was called before `.catch` was attached, which rejected this helper
    // and leaked the timer. `Promise.resolve().then(fn)` closes it.
    const syncThrow = (() => {
      throw new Error('sync boom');
    }) as () => Promise<void>;
    await expect(
      runBestEffortCleanup(syncThrow, { softTimeoutMs: 1000, context: 'ctx' }),
    ).resolves.toBeUndefined();
  });

  it('resolves via the soft timeout when cleanup overruns, without waiting for it', async () => {
    // A teardown is not a test: a slow sweep must warn and yield, not time out
    // the hook. The race resolves at the soft bound even though the cleanup
    // promise is still pending.
    let settled = false;
    const slow = runBestEffortCleanup(
      () => new Promise<void>((r) => setTimeout(r, 10_000)),
      { softTimeoutMs: 5, context: 'ctx' },
    ).then(() => { settled = true; });
    await slow;
    expect(settled).toBe(true);
  });
});

describe('describeSweepFailures', () => {
  it('is silent on a clean sweep', () => {
    expect(describeSweepFailures({ removed: ['a'], failed: [] }, 'ctx')).toBeNull();
  });

  it('does not promise the orphan sweeper where it cannot reach', () => {
    // The BYOD suite writes to its own project over MCP; telling a reader the
    // sweeper will pick it up turns a visible leak into one believed handled.
    const msg = describeSweepFailures(
      { removed: [], failed: [{ name: 'byod-smoke-1700000000000-repo', reason: 'HTTP 500' }] },
      'BYOD smoke',
      { sweeperCovers: false },
    );
    expect(msg).toContain('Delete them by hand');
    expect(msg).not.toContain('will be removed by the next');
  });

  it('names every leftover, so a leak is never invisible', () => {
    const msg = describeSweepFailures(
      { removed: [], failed: [{ name: 'smoke-1700000000000-a', reason: 'HTTP 500' }] },
      'memories REST smoke',
    );
    expect(msg).toContain('memories REST smoke');
    expect(msg).toContain('smoke-1700000000000-a');
    expect(msg).toContain('HTTP 500');
    expect(msg).toContain('scripts/smoke-cleanup.mjs');
  });
});

describe('mirror parity with scripts/smoke-cleanup.mjs', () => {
  const sweeperSource = readFileSync(
    fileURLToPath(new URL('../../../scripts/smoke-cleanup.mjs', import.meta.url)),
    'utf8',
  );

  it('carries a verbatim copy of the artefact pattern', () => {
    const m = /^const SMOKE_ARTEFACT_PATTERN = (.+);$/m.exec(sweeperSource);
    expect(m, 'scripts/smoke-cleanup.mjs must declare SMOKE_ARTEFACT_PATTERN at top level').not.toBeNull();
    expect(m?.[1]).toBe(SMOKE_ARTEFACT_PATTERN.toString());
  });

  it('forwards the run-environment header from req(), not just declaring it', () => {
    // The executable spread inside req() and the charset regex `.test()`, not a
    // charset mention a comment could satisfy — declaring runEnvHeaders() but
    // never spreading it would leave every sweep request untagged.
    expect(sweeperSource).toContain('...runEnvHeaders(),');
    expect(sweeperSource).toMatch(/function runEnvHeaders\(\)/);
    expect(sweeperSource).toMatch(/\/\^\[A-Za-z0-9_\.\\-:\]\+\$\/\.test\(/);
  });

  /**
   * Both strings below also appear in the sweeper's PROSE, so a bare
   * `toContain` stays green even if the real call loses them — the guard would
   * then be asserting its own documentation. Each is matched against the
   * executable line instead.
   */
  it('hard-deletes rather than archiving — an archived row is still a leaked row', () => {
    // The literal DELETE template, not the word "force" in a comment.
    expect(sweeperSource).toMatch(/key=\$\{encodeURIComponent\(key\)\}&force=true/);
  });

  it('purges orgs rather than soft-deleting them', () => {
    // The RPC path in the request URL, not the function name in a comment.
    expect(sweeperSource).toMatch(/\$\{PGREST\}\/rpc\/lorekit_org_purge/);
  });

  it('mirrors the two recognition helpers, not just the pattern', () => {
    // The regex alone is not the contract — a sweeper that recognises a name but
    // computes its age differently is just as broken.
    expect(sweeperSource).toContain('function smokeArtefactTimestamp(');
    expect(sweeperSource).toContain('function nameAgeMs(');
    expect(sweeperSource).toContain('mintedAt === null ? -Infinity : now - mintedAt');
  });

  it('takes age from the server timestamp and recognition from the name', () => {
    // The two must not be conflated: ANDing the name-derived staleness into the
    // filter lets a fast client clock veto a purge the server's age warrants.
    expect(sweeperSource).toContain('function rowAgeMs(');
    expect(sweeperSource).toContain('function orgAgeMs(');
    expect(sweeperSource).not.toContain('isStaleSmokeArtefact(');
  });

  it('never exits non-zero on a phase error unless --strict', () => {
    // A rejection at top level exits 1 regardless of --strict, and this script is
    // the last step of a job whose failure triggers rollback-production.
    expect(sweeperSource).toContain('async function phase(');
    expect(sweeperSource).toContain('process.exit(args.strict && failures.length ? 1 : 0)');
  });

  it('refuses every cross-tenant path without an explicit opt-in', () => {
    expect(sweeperSource).toContain('allowServiceRole');
    expect(sweeperSource).toContain("json?.role === 'service_role'");
    // Two independent gates: the service-role TOKEN, and the soft-deleted-org
    // phase, which is service-role by construction and so needs the same claim.
    expect(sweeperSource.match(/!args\.allowServiceRole/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // The token gate must not be exempted by --dry-run: enumeration is itself a
    // disclosure, since scope strings embed repo and project names.
    expect(sweeperSource).not.toContain('!args.dryRun && !args.allowServiceRole');
  });

  it('reports an exhausted page walk on both scans, never exits it silently', () => {
    expect(sweeperSource.match(/exceeded \$\{PAGE_SAFETY_STOP\} pages/g)?.length ?? 0).toBe(2);
  });
});
