// Scale/position sweep — deterministic node:test suite.
//
// AC-1  Reuse guard: sweep.mjs imports rankLessons from the real parity twin,
//        never re-encodes a ranking formula.
// AC-2  Decoy predicate: every generated decoy → shouldSurface === false;
//        no decoy key equals a ground-truth key.
// AC-3  Cliff ordering: recency arm's target degrades (leaves top-K) at a
//        SMALLER pool size than the ranked arm → ranked holds target longer →
//        summarizeCliff().ranked.cliffAt > recency.cliffAt.
// AC-4  Window eviction: past CANDIDATE_LIMIT the target is outside the recency
//        window in BOTH arms → window eviction, not score decay →
//        ranked.cliffAt > CANDIDATE_LIMIT.
// AC-5  Determinism: two runSweep calls with identical { seed, now } return
//        deep-equal curves.
// AC-8  Loud marking: decoy keys/values carry "SYNTHETIC DECOY" text.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { shouldSurface, buildGroundTruth } from "../../src/relevance/ground-truth.mjs";
import {
  CANDIDATE_LIMIT,
  makeDecoys,
  assemblePool,
  recencyOrder,
  rankedOrder,
  targetRank,
  runSweep,
  summarizeCliff,
} from "../../src/relevance/sweep.mjs";

// ── Fixed test harness ────────────────────────────────────────────────────────

const QUERY = { repo: "mthines/lorekit" };
const FIXED_NOW = new Date("2026-01-15T12:00:00Z").getTime();

// A single recurrence-confirmed target row (seen_count >= 3, outcome-signal tags).
// This represents a durable, old lesson — seated OLD (long before decoys) so
// the recency window can evict it once the pool grows large enough.
const TARGET_ROW = {
  scope: "repo::mthines/lorekit",
  key: "rls::service-role-user-filter",
  tags: ["security", "rls", "loop::review-outcomes"],
  value: "api_key auth uses the service-role client.",
  seen_count: 98,
  origin_repo: "mthines/lorekit",
  origin_pr: null,
  source: "review-comment",
  // old — 400 days before FIXED_NOW so it falls out of the recency window
  updated_at: new Date(FIXED_NOW - 400 * 24 * 60 * 60 * 1000).toISOString(),
};

// A "fresh" target variant — seated RECENT (1 day before FIXED_NOW).
// Used to prove the cliff is specific to old-but-salient targets (not fresh ones).
const TARGET_ROW_FRESH = {
  ...TARGET_ROW,
  key: "rls::service-role-fresh",
  updated_at: new Date(FIXED_NOW - 1 * 24 * 60 * 60 * 1000).toISOString(),
};

// Pool sizes that span the CANDIDATE_LIMIT boundary (200).
// Use a selection that includes sub-limit AND supra-limit sizes.
const POOL_SIZES = [10, 50, 100, 200, 300, 500];

// ── AC-1: Reuse guard ─────────────────────────────────────────────────────────

test("AC-1: sweep.mjs imports rankLessons from @lorekit/cli/src/lessons-pure.mjs", () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const src = fs.readFileSync(path.join(ROOT, "src", "relevance", "sweep.mjs"), "utf8");

  // The import must be present.
  assert.ok(
    src.includes('@lorekit/cli/src/lessons-pure.mjs'),
    'sweep.mjs must import from "@lorekit/cli/src/lessons-pure.mjs"',
  );

  // Strip comment lines up front — the docblock names `rankLessons` and the
  // formula identifiers repeatedly, so every symbol assertion below must run
  // against comment-stripped CODE or it cannot bite.
  const codeOnly = src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))  // drop single-line comments
    .join("\n");

  // rankLessons must be CALLED in code — match the call form `rankLessons(`, not
  // a bare mention. The docblock is stripped (codeOnly) and the `import { … }`
  // line has no trailing paren, so this fails if the real call site were deleted.
  assert.ok(
    /rankLessons\s*\(/.test(codeOnly),
    "sweep.mjs must call rankLessons (not just import it)",
  );

  // No re-encoded scoring formulas.  These are the exact identifiers the real
  // ranker uses internally — their presence in sweep.mjs CODE (outside comments)
  // would mean a copy.
  const forbidden = [
    /Math\.exp\(/,
    /Math\.log1p\(/,
    /\bLN2\b/,
    /halfLife\s*=/,          // assignment, not a parameter name
    /salienceFactor\s*=/,    // assignment, not an import alias
    /recencyFactor\s*=/,     // assignment, not an import alias
  ];
  for (const re of forbidden) {
    assert.equal(
      re.test(codeOnly),
      false,
      `sweep.mjs must not re-encode the ranking formula (found: ${re})`,
    );
  }
});

// ── AC-2: Decoy predicate ─────────────────────────────────────────────────────

test("AC-2: every generated decoy is not ground truth (shouldSurface === false for all decoys)", () => {
  const decoys = makeDecoys(50, { seed: 42, now: FIXED_NOW, ageSpreadDays: 30 });
  assert.ok(decoys.length > 0, "makeDecoys must return non-empty array");

  for (const decoy of decoys) {
    assert.equal(
      shouldSurface(decoy, QUERY),
      false,
      `decoy not ground truth — shouldSurface(decoy, query) must be false; decoy key=${decoy.key}`,
    );
  }
});

test("AC-2: no decoy key equals a ground-truth key", () => {
  const pool = [TARGET_ROW];
  const gt = buildGroundTruth(pool, QUERY);
  const gtKeys = new Set(gt.keys);
  const decoys = makeDecoys(100, { seed: 99, now: FIXED_NOW, ageSpreadDays: 60 });

  for (const decoy of decoys) {
    assert.equal(
      gtKeys.has(decoy.key),
      false,
      `decoy key must not collide with a ground-truth key; decoy key=${decoy.key}`,
    );
  }
});

// ── AC-8: Loud marking ────────────────────────────────────────────────────────

test("AC-8: decoy keys and values carry SYNTHETIC DECOY marker", () => {
  const decoys = makeDecoys(10, { seed: 7, now: FIXED_NOW, ageSpreadDays: 14 });
  for (const decoy of decoys) {
    const keyMarked = /SYNTHETIC.DECOY/i.test(decoy.key ?? "");
    const valMarked = /SYNTHETIC.DECOY/i.test(decoy.value ?? "");
    assert.ok(
      keyMarked || valMarked,
      `each decoy must carry a SYNTHETIC DECOY marker in key or value; key=${decoy.key}`,
    );
  }
});

// ── Basic API contracts ───────────────────────────────────────────────────────

test("targetRank returns 1-based rank when key is present, null when absent", () => {
  const keys = ["a", "b", "c"];
  assert.equal(targetRank(keys, "a"), 1);
  assert.equal(targetRank(keys, "c"), 3);
  assert.equal(targetRank(keys, "z"), null);
  assert.equal(targetRank([], "a"), null);
});

test("recencyOrder returns top-limit keys sorted by updated_at desc", () => {
  const older = { key: "old", updated_at: new Date(1000).toISOString(), tags: [] };
  const newer = { key: "new", updated_at: new Date(9000).toISOString(), tags: [] };
  const result = recencyOrder([older, newer], { limit: 2 });
  assert.deepEqual(result, ["new", "old"]);
});

test("recencyOrder respects the limit cap", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    key: `k${i}`,
    updated_at: new Date(i * 1000).toISOString(),
    tags: [],
  }));
  const result = recencyOrder(rows, { limit: 3 });
  assert.equal(result.length, 3);
});

test("rankedOrder window-cuts to CANDIDATE_LIMIT before ranking", () => {
  // A pool of 250 rows: target is OLD (row 0), decoys are NEWER.
  const rows = [];
  // Decoy rows — newer (inserted after target in time)
  for (let i = 1; i <= 249; i++) {
    rows.push({
      key: `decoy::window-test-${i}`,
      value: "SYNTHETIC DECOY window test",
      tags: [],
      seen_count: 0,
      scope: "global",
      updated_at: new Date(FIXED_NOW - (250 - i) * 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  // Old target — oldest row
  rows.push({ ...TARGET_ROW, updated_at: new Date(FIXED_NOW - 400 * 24 * 60 * 60 * 1000).toISOString() });

  const result = rankedOrder(rows, { now: FIXED_NOW, limit: 50, windowLimit: CANDIDATE_LIMIT });
  // With 250 rows and window=200, the oldest row (TARGET_ROW) is evicted.
  assert.equal(
    result.includes(TARGET_ROW.key),
    false,
    "old target evicted from window when pool > CANDIDATE_LIMIT",
  );
  assert.ok(result.length <= 50);
});

// ── AC-3: Cliff ordering ──────────────────────────────────────────────────────

test("AC-3: summarizeCliff reports ranked.cliffAt > recency.cliffAt for an old target", () => {
  const curve = runSweep({
    targetRows: [TARGET_ROW],
    query: QUERY,
    poolSizes: POOL_SIZES,
    k: 5,
    now: FIXED_NOW,
    seed: 123,
    targetAgeDays: 400,
  });

  assert.ok(curve.length > 0, "runSweep must return a non-empty curve");

  const cliff = summarizeCliff(curve);

  // Both cliffs must be findable in this pool-size range.
  assert.ok(
    cliff.recency.cliffAt !== null,
    `recency cliff must be found in pool sizes ${POOL_SIZES.join(",")}`,
  );
  assert.ok(
    cliff.ranked.cliffAt !== null,
    `ranked cliff must be found in pool sizes ${POOL_SIZES.join(",")}`,
  );

  // Ranked holds the target in top-K longer.
  assert.ok(
    cliff.ranked.cliffAt > cliff.recency.cliffAt,
    `ranked arm must hold target longer: ranked.cliffAt=${cliff.ranked.cliffAt} should be > recency.cliffAt=${cliff.recency.cliffAt}`,
  );
});

// ── AC-4: Window eviction ─────────────────────────────────────────────────────

test("AC-4: at pool > CANDIDATE_LIMIT the old target is outside the recency window in both arms", () => {
  const curve = runSweep({
    targetRows: [TARGET_ROW],
    query: QUERY,
    poolSizes: POOL_SIZES,
    k: 5,
    now: FIXED_NOW,
    seed: 123,
    targetAgeDays: 400,
  });

  // Find the first record where pool > CANDIDATE_LIMIT.
  const supraRecord = curve.find((r) => r.poolSize > CANDIDATE_LIMIT);
  assert.ok(
    supraRecord !== undefined,
    `must have at least one pool size > CANDIDATE_LIMIT (${CANDIDATE_LIMIT}); pool sizes: ${POOL_SIZES.join(",")}`,
  );

  // In both arms, the target must be outside the window once pool > CANDIDATE_LIMIT.
  assert.equal(
    supraRecord.recency.targetInWindow,
    false,
    `recency arm: old target must be outside window at poolSize=${supraRecord.poolSize}`,
  );
  assert.equal(
    supraRecord.ranked.targetInWindow,
    false,
    `ranked arm: old target must be outside window at poolSize=${supraRecord.poolSize}`,
  );

  const cliff = summarizeCliff(curve);
  assert.ok(
    cliff.ranked.cliffAt > CANDIDATE_LIMIT,
    `ranked.cliffAt (${cliff.ranked.cliffAt}) must be > CANDIDATE_LIMIT (${CANDIDATE_LIMIT}) — window eviction, not score decay`,
  );
});

// ── AC-5: Determinism ─────────────────────────────────────────────────────────

test("AC-5: two runSweep calls with the same { seed, now } are deep-equal (deterministic)", () => {
  const opts = {
    targetRows: [TARGET_ROW],
    query: QUERY,
    poolSizes: [10, 50, 200, 300],
    k: 5,
    now: FIXED_NOW,
    seed: 777,
    targetAgeDays: 400,
  };
  const curve1 = runSweep(opts);
  const curve2 = runSweep(opts);
  assert.deepEqual(curve1, curve2, "runSweep must be fully deterministic");
});

// ── Edge case: fresh target has no cliff at the sizes we test ─────────────────

test("fresh target stays in window when decoys are placed older (cliff is for old-but-salient targets)", () => {
  // When a target is FRESH (1 day old) and decoys are placed OLDER than the
  // target, the target stays at the front of the recency window even at large N.
  // This documents the cliff is specific to the old-but-salient scenario (not
  // to fresh targets).
  //
  // We use assemblePool with decoysOlderThanTarget:true to place decoys older
  // than the target, then verify with recencyOrder.
  const freshTarget = {
    ...TARGET_ROW_FRESH,
    updated_at: new Date(FIXED_NOW - 1 * 24 * 60 * 60 * 1000).toISOString(),
  };

  // 300-row pool: fresh target (1 day old) + 299 decoys placed 2–32 days old.
  const pool = assemblePool([freshTarget], 299, {
    seed: 42,
    now: FIXED_NOW,
    targetAgeDays: 1,
    ageSpreadDays: 30,
    decoysOlderThanTarget: true,
  });

  // Sort by recency: fresh target should be #1.
  const topKeys = recencyOrder(pool, { limit: 50 });
  assert.equal(
    topKeys[0],
    freshTarget.key,
    "fresh target should be the most recent row when decoys are older",
  );
  assert.ok(
    topKeys.includes(freshTarget.key),
    "fresh target must be in the top-50 recency order when decoys are placed older",
  );
});

// ── runSweep output shape ─────────────────────────────────────────────────────

test("runSweep returns one record per requested pool size with correct shape", () => {
  const sizes = [10, 50];
  const curve = runSweep({
    targetRows: [TARGET_ROW],
    query: QUERY,
    poolSizes: sizes,
    k: 3,
    now: FIXED_NOW,
    seed: 1,
    targetAgeDays: 400,
  });

  assert.equal(curve.length, sizes.length);
  for (const rec of curve) {
    assert.ok("poolSize" in rec);
    assert.ok("targetKey" in rec);
    assert.ok("windowLimit" in rec);
    assert.ok("k" in rec);
    assert.ok("recency" in rec);
    assert.ok("ranked" in rec);
    assert.ok("precisionAtK" in rec.recency);
    assert.ok("recallAtK" in rec.recency);
    assert.ok("targetRank" in rec.recency);
    assert.ok("targetInWindow" in rec.recency);
    assert.ok("precisionAtK" in rec.ranked);
    assert.ok("recallAtK" in rec.ranked);
    assert.ok("targetRank" in rec.ranked);
    assert.ok("targetInWindow" in rec.ranked);
  }
});
