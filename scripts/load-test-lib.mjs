/**
 * The pure half of the load test — everything worth unit-testing, lifted out of
 * the runner so it is not only observable as a wrong number in a report.
 *
 * The runner (`load-test.mjs`) owns provisioning, HTTP and cleanup. This file
 * owns the decisions that are silently wrong when wrong: how a target is
 * resolved, how an arrival schedule is built, how percentiles are computed, and
 * how two cumulative `pg_stat_statements` snapshots are differenced.
 */

/** Requests LoreKit's REST surface can be driven with, and their weights. */
export const DEFAULT_MIX = Object.freeze([
  // Reads dominate, matching how agents actually use lore: a SessionStart
  // injection reads, a retrospective writes once.
  { op: 'list', weight: 50 },
  { op: 'search', weight: 25 },
  { op: 'scopes', weight: 10 },
  // The one rate-limited REST route (`create.ts` checks the limit), kept in the
  // mix at a low weight ON PURPOSE: it is where a 429 should first appear, and
  // a load test that never writes never exercises the cap trigger either.
  { op: 'write', weight: 15 },
]);

/**
 * Resolve the target, refusing to guess.
 *
 * There is no default. A load test points at a real deployment and writes real
 * rows, so "forgot the flag" must fail rather than pick something — and
 * `production` must be typed in full rather than reached by omission.
 */
export function resolveTarget(argvTarget, env = {}) {
  const raw = (argvTarget ?? env.LOREKIT_LOAD_TARGET ?? '').trim().toLowerCase();
  if (!raw) {
    return { ok: false, error: 'No target. Pass --target preview|production (or set LOREKIT_LOAD_TARGET). There is deliberately no default.' };
  }
  if (raw !== 'preview' && raw !== 'production') {
    return { ok: false, error: `Unknown target "${raw}". Expected preview or production.` };
  }
  return { ok: true, target: raw };
}

/**
 * Build the arrival schedule: offsets in ms from t0, one per request.
 *
 * OPEN LOOP. The offsets are fixed up front from the requested rate, and the
 * driver fires each when its time comes regardless of whether earlier requests
 * have returned. A closed loop — N workers each looping "send, await, send" —
 * measures something else and flatters the server: when it slows down you send
 * fewer requests, so the offered load drops exactly when you most want it held
 * constant. That is coordinated omission, and it is why a closed-loop harness
 * reports a p99 far better than users experience.
 *
 * Evenly spaced rather than Poisson-distributed: a fixed interval makes two
 * runs comparable, which is the point of exporting them. Burstiness is a
 * different experiment.
 */
export function buildSchedule({ rps, durationSec }) {
  if (!(rps > 0) || !(durationSec > 0)) return [];
  const total = Math.round(rps * durationSec);
  const gapMs = 1000 / rps;
  return Array.from({ length: total }, (_, i) => Math.round(i * gapMs));
}

/**
 * Expand a weighted mix into a concrete op sequence of `length`.
 *
 * Deterministic rather than random draws: two runs of the same config issue the
 * same request sequence, so a difference between them is the system changing
 * rather than the dice.
 *
 * The ops are INTERLEAVED, not grouped. A naive `pool[i % pool.length]` over a
 * grouped expansion (50 `list`, then 25 `search`, then…) looks correct and is
 * badly wrong for short runs: a 75-request run over a 100-weight mix never
 * reaches the last two ops at all, so `scopes` and `write` are silently never
 * issued — and `write` is the only rate-limited route and the only one that
 * exercises the cap trigger. Found by running it; a 1000-request unit test
 * hides it completely.
 *
 * The interleave places each op's occurrences at evenly spaced fractions of the
 * cycle, so EVERY PREFIX approximates the requested weights.
 */
export function buildOpSequence(length, mix = DEFAULT_MIX) {
  if (length <= 0) return [];

  const slots = [];
  for (const { op, weight } of mix) {
    const w = Math.max(0, Math.round(weight));
    for (let j = 0; j < w; j += 1) {
      // Spread this op's w occurrences across [0, 1). `op` breaks ties so the
      // ordering is total and therefore reproducible.
      slots.push({ op, at: (j + 0.5) / w });
    }
  }
  if (!slots.length) return [];
  slots.sort((a, b) => (a.at - b.at) || a.op.localeCompare(b.op));

  return Array.from({ length }, (_, i) => slots[i % slots.length].op);
}

/**
 * Percentiles over a sample array, by nearest-rank on the sorted values.
 *
 * Nearest-rank (not interpolated): a latency percentile should be a value that
 * was actually observed. Interpolating invents a number between two real
 * measurements, which is misleading at small sample sizes — exactly where a
 * short load run lives.
 */
export function percentile(samples, p) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  // ceil(p * n) - 1, clamped: p=0 gives the min, p=1 gives the max.
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Summarise per-op results.
 *
 * `ok` counts 2xx only. `rateLimited` (429) is broken out because it is not a
 * failure — it is the guardrail working, and lumping it into errors would make
 * a correctly-throttled run look broken. `errors` is 5xx plus transport
 * failures: those are the ones that mean something is wrong.
 */
export function summarize(results) {
  const byOp = new Map();
  for (const r of results) {
    if (!byOp.has(r.op)) byOp.set(r.op, []);
    byOp.get(r.op).push(r);
  }

  const rows = [];
  for (const [op, rs] of [...byOp.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Latency percentiles over SUCCESSFUL requests only. A 429 returns in
    // microseconds and a transport failure may return instantly or after a
    // timeout; folding either into the latency distribution moves p95 for
    // reasons that have nothing to do with how fast the service is.
    const okLatencies = rs.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.ms);
    rows.push({
      op,
      count: rs.length,
      ok: rs.filter((r) => r.status >= 200 && r.status < 300).length,
      rateLimited: rs.filter((r) => r.status === 429).length,
      clientErrors: rs.filter((r) => r.status >= 400 && r.status < 500 && r.status !== 429).length,
      errors: rs.filter((r) => r.status >= 500 || r.status === 0).length,
      p50: percentile(okLatencies, 0.5),
      p95: percentile(okLatencies, 0.95),
      p99: percentile(okLatencies, 0.99),
      max: okLatencies.length ? Math.max(...okLatencies) : null,
    });
  }
  return rows;
}

/** Aggregate totals across every op, for the headline line. */
export function totals(results) {
  const ok = results.filter((r) => r.status >= 200 && r.status < 300);
  return {
    requests: results.length,
    ok: ok.length,
    rateLimited: results.filter((r) => r.status === 429).length,
    errors: results.filter((r) => r.status >= 500 || r.status === 0).length,
    p50: percentile(ok.map((r) => r.ms), 0.5),
    p95: percentile(ok.map((r) => r.ms), 0.95),
    p99: percentile(ok.map((r) => r.ms), 0.99),
  };
}

/**
 * Diff two `lorekit_db_query_stats()` snapshots.
 *
 * The counters are CUMULATIVE since `stats_reset`, so a raw top-N is dominated
 * by whatever the database did before the run started. The delta is the only
 * view that describes THIS run, and it is the sharpest output the harness
 * produces: it turns "p95 was 240 ms" into "62 % of it was these three
 * statements".
 *
 * A statement present in `after` but not `before` counts fully — it first ran
 * during the load. A `stats_reset` mid-run would make deltas negative; those
 * are dropped rather than reported as negative work, since a reset means the
 * baseline is meaningless rather than that time went backwards.
 */
export function diffQueryStats(before, after) {
  const index = new Map((before ?? []).map((r) => [r.queryid, r]));
  const rows = [];

  for (const row of after ?? []) {
    const prev = index.get(row.queryid);
    const deltaMs = Number(row.total_exec_ms ?? 0) - Number(prev?.total_exec_ms ?? 0);
    const deltaCalls = Number(row.calls ?? 0) - Number(prev?.calls ?? 0);
    const deltaRows = Number(row.rows_returned ?? 0) - Number(prev?.rows_returned ?? 0);

    // No calls in the window means the statement did not participate, even if
    // it dominates the cumulative totals.
    if (deltaCalls <= 0) continue;
    // Negative time with positive calls is a counter reset, not a measurement.
    if (deltaMs < 0) continue;

    rows.push({
      queryid: row.queryid,
      query: row.query,
      toplevel: row.toplevel ?? null,
      calls: deltaCalls,
      totalMs: deltaMs,
      meanMs: deltaMs / deltaCalls,
      rows: deltaRows,
      isNew: !prev,
    });
  }

  return rows.sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * What share of measured request time the database can account for.
 *
 * Deliberately reported as a RATIO with both terms shown rather than a bare
 * percentage: the two are measured on different sides of the wire (client
 * wall-clock vs. server-side exec time) and over different populations, so it
 * is an indication of where to look, never an identity. A value above 1 is
 * possible and meaningful — it says the database did more work than the client
 * waited for, which is what concurrency looks like.
 */
export function dbShare(results, queryDiff) {
  const clientMs = results
    .filter((r) => r.status >= 200 && r.status < 300)
    .reduce((n, r) => n + r.ms, 0);
  const dbMs = queryDiff.reduce((n, r) => n + r.totalMs, 0);
  if (clientMs <= 0) return null;
  return { clientMs, dbMs, ratio: dbMs / clientMs };
}
