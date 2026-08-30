// Scale/position sweep — pure, offline composition of existing functions.
//
// This module answers the founding question: does a genuinely-relevant lesson
// still get surfaced once a repo accumulates a lot of memories, and at what pool
// size does relevance degrade (the "cliff")?
//
// DESIGN: the sweep is fully below-the-model.  It composes three existing
// functions — the real ground-truth predicate (ground-truth.mjs), the real
// ranking function (rankLessons from @lorekit/cli/src/shared/lessons-pure.mjs), and
// the retrieval-relevance metrics (relevance-metrics.mjs) — and adds only the
// pool-injection and the window-modeling scaffolding.  No new logic replaces
// existing logic; the only genuinely new pieces are:
//   • the synthetic decoy factory (makeDecoys) — because no real decoy/volume
//     generator exists and online corpus is unavailable offline;
//   • the two arm models (recencyOrder / rankedOrder) — the trivial recency
//     baseline and the CANDIDATE_LIMIT-window → rankLessons path;
//   • targetRank — a 1-based helper not yet in relevance-metrics.mjs;
//   • runSweep and summarizeCliff — the loop + the cliff reporter.
//
// REUSE, NOT RE-ENCODING. The ranked arm calls rankLessons from the CLI's
// zero-import parity twin — the SAME function the hook engine and read commands
// use. Re-encoding the ranker here would be the "mock-that-reimplements-the-
// thing-under-test" trap (global lesson, seen_count 6, structural). The test
// suite greps this file to prove the import is present and no local scoring
// formula does not appear here.
//
// SYNTHETIC DECOYS — BOOTSTRAP PLACEHOLDER. Decoys are synthesized offline.
// At real volume this sweep should be re-run against a corpus mined via
// bin/mine-ground-truth.mjs.  Every decoy is loudly marked "SYNTHETIC DECOY"
// in its key and value so a reader cannot mistake them for real lessons.
// By construction decoys carry no outcome/relevance tags, so shouldSurface()
// returns false for every decoy — no decoy can accidentally enter the ground
// truth.
//
// THE CANDIDATE_LIMIT WINDOW. The product's ranked path (relevant.ts /
// tools.ts) is NOT a global rank — it is:
//   1. fetch the most-recent CANDIDATE_LIMIT (= 200) candidates
//      (updated_at desc);
//   2. rank WITHIN that window with rankLessons.
// An old lesson with a high seen_count that falls outside the window is never
// ranked, no matter how salient. That is the cliff this sweep measures.
// Source: supabase/functions/memories/handlers/relevant.ts and
//         supabase/functions/mcp/tools.ts.

import { rankLessons } from "@lorekit/cli/src/shared/lessons-pure.mjs";
import { buildGroundTruth, shouldSurface } from "./ground-truth.mjs";
import {
  precisionAtK,
  recallAtK,
} from "./relevance-metrics.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The recency-window size used by the product's ranked path.
 *
 * SOURCE: `CANDIDATE_LIMIT = 200` in
 *   supabase/functions/memories/handlers/relevant.ts
 *   supabase/functions/mcp/tools.ts
 *
 * This is a MIRROR of the Deno-side TypeScript constant, not an import (the
 * edge file is not importable from a Node .mjs without lockfile-touching
 * dependencies). A parity comment cites the source so a reader can verify.
 */
export const CANDIDATE_LIMIT = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Tiny deterministic PRNG (mulberry32) — zero imports, seeded by the caller.
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a seeded pseudo-random number generator in [0, 1). */
function makePrng(seed) {
  let s = (seed >>> 0) || 1; // avoid zero seed
  return function prng() {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoy factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Synthesize `count` decoy rows.
 *
 * Decoys are BOOTSTRAP PLACEHOLDERS for real corpus at volume. They carry NO
 * outcome/relevance tags so `shouldSurface(decoy, query)` is always false — a
 * decoy cannot accidentally enter the ground truth.  Keys and values are loudly
 * marked "SYNTHETIC DECOY" so they cannot be mistaken for real lessons.
 *
 * The decoy generator is fully seeded: given the same `{ seed, now,
 * ageSpreadDays }`, it always produces the same rows — required for
 * deterministic test repeatability (AC-5).
 *
 * Decoys are placed as more-RECENT rows than the target (the target is seated
 * OLD by the caller via `assemblePool`). This models the real scenario: a repo
 * accumulates fresh lessons over time, pushing old-but-salient ones deeper.
 *
 * @param {number}  count         Number of decoys to generate.
 * @param {object}  opts
 * @param {number}  opts.seed     Integer seed for the PRNG.
 * @param {number}  opts.now      Reference timestamp (ms since epoch).
 * @param {number}  [opts.ageSpreadDays=30]  Decoys are between 0 and this many
 *                                            days before `now`.
 * @returns {object[]}
 */
export function makeDecoys(count, { seed = 1, now = Date.now(), ageSpreadDays = 30 } = {}) {
  const prng = makePrng(seed);
  const n = Math.max(0, Math.floor(count));
  const spread = Math.max(1, ageSpreadDays) * 24 * 60 * 60 * 1000;

  return Array.from({ length: n }, (_, i) => {
    const ageFrac = prng(); // 0..1
    const ageMs = Math.floor(ageFrac * spread);
    const updated_at = new Date(now - ageMs).toISOString();
    return {
      // Key is loudly namespaced and marked — the test greps for "SYNTHETIC DECOY".
      key: `decoy::SYNTHETIC-DECOY-${i}-s${seed}`,
      value: `SYNTHETIC DECOY row ${i} (seed=${seed}) — placeholder for real corpus at volume. Upgrade: bin/mine-ground-truth.mjs`,
      // No outcome/relevance tags — shouldSurface() must return false.
      tags: [],
      seen_count: Math.floor(prng() * 3), // 0–2: never confirmed (< RECURRENCE_CONFIRMED_AT = 3)
      scope: "global",
      updated_at,
      source: "synthetic",
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble a pool of (targetRows + decoys), with the target seated OLD.
 *
 * Decoys are generated fresh and placed as MORE RECENT rows than the target.
 * The target's `updated_at` is overridden to be `targetAgeDays` days before
 * `now`, so on pools exceeding `CANDIDATE_LIMIT` the target falls outside the
 * recency window — the scenario the sweep is designed to measure.
 *
 * @param {object[]} targetRows     The real ground-truth rows (from the mock or mine).
 * @param {number}   decoyCount     How many decoys to inject.
 * @param {object}   opts
 * @param {number}   opts.seed
 * @param {number}   opts.now
 * @param {number}   [opts.targetAgeDays=400]  How old to seat the target (in days before now).
 * @param {number}   [opts.ageSpreadDays=30]   Decoy age spread (days).
 * @param {boolean}  [opts.decoysOlderThanTarget=false]  When true, decoys are placed OLDER
 *                                             than the target (useful for testing a fresh target
 *                                             that should stay in window even at large N).
 * @returns {object[]}
 */
export function assemblePool(targetRows, decoyCount, {
  seed = 1,
  now = Date.now(),
  targetAgeDays = 400,
  ageSpreadDays = 30,
  decoysOlderThanTarget = false,
} = {}) {
  // Seat the target rows as OLD so they fall out of the window on large pools
  // (default path), or as fresh (when targetAgeDays is small).
  const targetAgeMs = Math.max(1, targetAgeDays) * 24 * 60 * 60 * 1000;
  const seatedTargets = (Array.isArray(targetRows) ? targetRows : []).map((r, i) => ({
    ...r,
    // Stagger multiple targets slightly so their updated_at are distinct.
    updated_at: new Date(now - targetAgeMs - i * 60 * 1000).toISOString(),
  }));

  // Default: decoys are MORE RECENT — they land inside the recency window ahead of the target.
  // When decoysOlderThanTarget: true, decoys are placed at targetAgeDays+spread, i.e. OLDER.
  // This models the scenario where the target is fresh and the decoys are stale background noise.
  const decoyBaseAge = decoysOlderThanTarget
    ? new Date(now - (targetAgeMs + 1 * 24 * 60 * 60 * 1000)).getTime()
    : now;
  const decoys = makeDecoys(decoyCount, { seed, now: decoyBaseAge, ageSpreadDays });

  return [...seatedTargets, ...decoys];
}

// ─────────────────────────────────────────────────────────────────────────────
// Arms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The recency arm: sort the full pool by `updated_at` desc, return the top-`limit` keys.
 *
 * This is the "no ranking" baseline — it models the product's default
 * `GET /memories` order (updated_at desc) with no score-based reranking.
 *
 * @param {object[]} rows
 * @param {object}   opts
 * @param {number}   [opts.limit=50]
 * @returns {string[]}
 */
export function recencyOrder(rows, { limit = 50 } = {}) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => {
    const ta = a?.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b?.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta; // descending: newest first
  });
  return list.slice(0, limit).map((r) => r.key ?? null).filter((k) => typeof k === "string");
}

/**
 * The ranked arm: take the `windowLimit` most-recent candidates, then rank with
 * `rankLessons`, return the top-`limit` keys.
 *
 * This reproduces the product's ACTUAL `order=rank` path (relevant.ts):
 *   1. Recency window — fetch the `windowLimit` newest candidates.
 *   2. Rank within the window using the real `rankLessons`.
 *   3. Return top-`limit`.
 *
 * An old target that falls outside the window is CUT before ranking — that is
 * the window-eviction cliff (AC-4).
 *
 * REUSE, NOT RE-ENCODING. The ranking is done by the REAL `rankLessons` from
 * `@lorekit/cli/src/shared/lessons-pure.mjs`, the offline parity twin of the edge
 * ranker. This file contains NO local scoring formula.
 *
 * @param {object[]} rows
 * @param {object}   opts
 * @param {number}   opts.now
 * @param {number}   [opts.limit=50]
 * @param {number}   [opts.windowLimit=CANDIDATE_LIMIT]
 * @returns {string[]}
 */
export function rankedOrder(rows, { now = Date.now(), limit = 50, windowLimit = CANDIDATE_LIMIT } = {}) {
  const list = Array.isArray(rows) ? [...rows] : [];

  // Step 1: recency window — newest `windowLimit` rows.
  list.sort((a, b) => {
    const ta = a?.updated_at ? new Date(a.updated_at).getTime() : 0;
    const tb = b?.updated_at ? new Date(b.updated_at).getTime() : 0;
    return tb - ta;
  });
  const window = list.slice(0, windowLimit);

  // Step 2: rank within the window.
  const ranked = rankLessons(window, { now });

  // Step 3: top-limit keys.
  return ranked.slice(0, limit).map((r) => r.key ?? null).filter((k) => typeof k === "string");
}

// ─────────────────────────────────────────────────────────────────────────────
// targetRank helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 1-based rank of `targetKey` in `rankedKeys`, or `null` if absent.
 *
 * `reciprocalRank` in relevance-metrics.mjs returns the reciprocal (1/rank);
 * the sweep's curve axis is the raw rank number.
 *
 * @param {string[]} rankedKeys  Ordered list (best first).
 * @param {string}   targetKey
 * @returns {number|null}
 */
export function targetRank(rankedKeys, targetKey) {
  const keys = Array.isArray(rankedKeys) ? rankedKeys : [];
  const i = keys.indexOf(targetKey);
  return i >= 0 ? i + 1 : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the scale/position sweep for a fixed ground-truth target across increasing
 * pool sizes, both arms (recency vs ranked).
 *
 * For each pool size N the sweep:
 *   1. Assembles a pool of (targetRows + N-1 decoys), with the target seated OLD.
 *   2. Runs the recency arm (no ranking) and records metrics + target-rank.
 *   3. Runs the ranked arm (CANDIDATE_LIMIT window → rankLessons) and records metrics.
 *   4. Returns one record per pool size.
 *
 * The target is seated `targetAgeDays` before `now`; decoys are MORE RECENT so they
 * occupy the front of the recency window. Past pool size CANDIDATE_LIMIT the target
 * falls outside the window entirely — both arms lose sight of it (AC-4), which is
 * the window-eviction cliff.
 *
 * @param {object}   opts
 * @param {object[]} opts.targetRows      The ground-truth target rows.
 * @param {object}   opts.query           The query object ({ repo? }).
 * @param {number[]} opts.poolSizes       Pool sizes to sweep (e.g. [10, 50, 200, 500]).
 * @param {number}   [opts.k=5]           k for precision@k / recall@k.
 * @param {number}   [opts.now]           Reference timestamp (ms). Default: Date.now().
 * @param {number}   [opts.seed=1]        Decoy PRNG seed.
 * @param {number}   [opts.targetAgeDays=400]  Days before now the target is seated.
 * @returns {Array<SweepRecord>}
 */
export function runSweep({
  targetRows = [],
  query = {},
  poolSizes = [10, 50, 200, 500],
  k = 5,
  now = Date.now(),
  seed = 1,
  targetAgeDays = 400,
} = {}) {
  const gt = buildGroundTruth(targetRows, query);
  if (gt.keys.length === 0) {
    throw new Error(
      "runSweep: ground truth is empty — targetRows must contain at least one row that satisfies shouldSurface(row, query). " +
      "A vacuous perfect score is prevented by design (mirrors A0's empty-baseline refusal).",
    );
  }
  // Use the first target key as the curve axis — the row the sweep tracks.
  const primaryTargetKey = gt.keys[0];

  const limit = 50; // the product's default page size (mirrors relevant.ts)
  const windowLimit = CANDIDATE_LIMIT;

  return poolSizes.map((poolSize) => {
    const decoyCount = Math.max(0, poolSize - targetRows.length);
    // Use a pool-size-specific sub-seed so different pool sizes don't share decoy rows.
    const poolSeed = seed ^ (poolSize * 2654435761) >>> 0;
    const pool = assemblePool(targetRows, decoyCount, {
      seed: poolSeed,
      now,
      targetAgeDays,
      ageSpreadDays: Math.min(targetAgeDays - 1, 30),
    });

    // ── recency arm ───────────────────────────────────────────────────────────
    // The recency window for the RECENCY arm is the full pool sorted desc —
    // there is no explicit candidate-limit cap in the plain recency baseline
    // (it is the baseline UNDER TEST).  We take the top-`limit` rows.
    const recencyKeys = recencyOrder(pool, { limit });
    // `recencyKeys` is already the top-`limit` recency-sorted keys; the target is
    // in the recency window iff it appears there — derive it directly rather than
    // re-sorting and re-slicing the pool.
    const recencyInWindow = recencyKeys.includes(primaryTargetKey);

    const recencyTgtRank = targetRank(recencyKeys, primaryTargetKey);

    // ── ranked arm ────────────────────────────────────────────────────────────
    // The ranked arm applies the CANDIDATE_LIMIT recency window first, THEN ranks.
    // Step 1 window — what rankLessons actually sees.
    const sortedForWindow = pool
      .slice()
      .sort((a, b) => {
        const ta = a?.updated_at ? new Date(a.updated_at).getTime() : 0;
        const tb = b?.updated_at ? new Date(b.updated_at).getTime() : 0;
        return tb - ta;
      });
    const candidateWindow = sortedForWindow.slice(0, windowLimit);
    const targetInCandidateWindow = candidateWindow.some((r) => r.key === primaryTargetKey);

    const rankedKeys = rankedOrder(pool, { now, limit, windowLimit });
    const rankedTgtRank = targetRank(rankedKeys, primaryTargetKey);

    // ── metrics ───────────────────────────────────────────────────────────────
    const truthKeys = gt.keys;

    return {
      poolSize,
      targetKey: primaryTargetKey,
      windowLimit,
      k,
      recency: {
        precisionAtK: precisionAtK(recencyKeys, truthKeys, k),
        recallAtK: recallAtK(recencyKeys, truthKeys, k),
        targetRank: recencyTgtRank,
        targetInWindow: recencyInWindow,
      },
      ranked: {
        precisionAtK: precisionAtK(rankedKeys, truthKeys, k),
        recallAtK: recallAtK(rankedKeys, truthKeys, k),
        targetRank: rankedTgtRank,
        targetInWindow: targetInCandidateWindow,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cliff reporter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the sweep curve and name the first pool size at which each arm loses the
 * target from its top-50 page (targetRank === null, where the page size is the
 * hard-coded `limit = 50`, not `k`). That boundary is the cliff.
 *
 * For the ranked arm the cliff is specifically the WINDOW-EVICTION cliff
 * (targetInWindow === false AND targetRank === null), not merely score decay.
 *
 * @param {Array<SweepRecord>} curve  Output of `runSweep`.
 * @returns {{ recency: { cliffAt: number|null }, ranked: { cliffAt: number|null } }}
 */
export function summarizeCliff(curve) {
  const records = Array.isArray(curve) ? curve : [];

  let recencyCliff = null;
  let rankedCliff = null;

  for (const rec of records) {
    if (recencyCliff === null && rec.recency.targetRank === null) {
      recencyCliff = rec.poolSize;
    }
    if (rankedCliff === null && rec.ranked.targetRank === null) {
      rankedCliff = rec.poolSize;
    }
    if (recencyCliff !== null && rankedCliff !== null) break;
  }

  return {
    recency: { cliffAt: recencyCliff },
    ranked: { cliffAt: rankedCliff },
  };
}
