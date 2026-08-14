import assert from "node:assert/strict";
import { test } from "node:test";

import {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  meanReciprocalRank,
  mrr,
  scoreRanking,
  BASELINE_BOOTSTRAP,
  BASELINE_REAL,
  BOOTSTRAP_WARNING,
} from "../src/relevance-metrics.mjs";

// A single-relevant scenario with the true item at rank 2 — the canonical
// worked example the plan pins: mrr = 1/2, precision@1 = 0, recall@2 = 1.
const RANKED = ["wrong-a", "right", "wrong-b", "wrong-c"];
const TRUTH = ["right"];

test("AC-2: reciprocal rank of a rank-2 hit is 0.5", () => {
  assert.equal(reciprocalRank(RANKED, TRUTH), 0.5);
  assert.equal(mrr(RANKED, TRUTH), 0.5);
});

test("AC-2: precision@1 is 0 when the top item is wrong", () => {
  assert.equal(precisionAtK(RANKED, TRUTH, 1), 0);
});

test("AC-2: precision@2 is 0.5 (one of two top items relevant)", () => {
  assert.equal(precisionAtK(RANKED, TRUTH, 2), 0.5);
});

test("AC-2: recall@1 is 0, recall@2 is 1 for a single-relevant set", () => {
  assert.equal(recallAtK(RANKED, TRUTH, 1), 0);
  assert.equal(recallAtK(RANKED, TRUTH, 2), 1);
});

test("AC-2: a perfect ranking scores 1 across the board", () => {
  const ranked = ["a", "b", "c"];
  const truth = ["a", "b"];
  assert.equal(reciprocalRank(ranked, truth), 1);
  assert.equal(precisionAtK(ranked, truth, 2), 1);
  assert.equal(recallAtK(ranked, truth, 2), 1);
});

test("AC-2: a miss scores 0 reciprocal rank and 0 recall", () => {
  assert.equal(reciprocalRank(["x", "y"], ["z"]), 0);
  assert.equal(recallAtK(["x", "y"], ["z"], 5), 0);
  assert.equal(precisionAtK(["x", "y"], ["z"], 5), 0);
});

test("precision@k denominator is the retrieved count when fewer than k retrieved", () => {
  // Two retrieved, both relevant, k=5 → precision is 2/2 = 1, not 2/5.
  assert.equal(precisionAtK(["a", "b"], ["a", "b", "c"], 5), 1);
});

test("recall of an empty ground truth is 1 (nothing to miss)", () => {
  assert.equal(recallAtK(["a"], [], 3), 1);
});

test("empty retrieval scores 0 precision and 0 reciprocal rank", () => {
  assert.equal(precisionAtK([], ["a"], 3), 0);
  assert.equal(reciprocalRank([], ["a"]), 0);
});

test("meanReciprocalRank averages per-query reciprocal ranks", () => {
  const results = [
    { ranked: ["a", "b"], groundTruth: ["a"] }, // rr = 1
    { ranked: ["x", "y"], groundTruth: ["y"] }, // rr = 1/2
  ];
  assert.equal(meanReciprocalRank(results), 0.75);
  assert.equal(meanReciprocalRank([]), 0);
});

test("AC-2: scoreRanking rolls up p@k / r@k / mrr and stamps the bootstrap warning", () => {
  const score = scoreRanking({
    ranked: RANKED,
    groundTruth: { keys: TRUTH },
    ks: [1, 2],
    baselineSource: BASELINE_BOOTSTRAP,
  });
  assert.equal(score.mrr, 0.5);
  assert.equal(score.precisionAtK[1], 0);
  assert.equal(score.precisionAtK[2], 0.5);
  assert.equal(score.recallAtK[1], 0);
  assert.equal(score.recallAtK[2], 1);
  assert.equal(score.groundTruthSize, 1);
  assert.equal(score.baseline.source, BASELINE_BOOTSTRAP);
  assert.equal(score.baseline.rowCount, 1);
  // The loud caveat travels with the DATA, not just the README.
  assert.match(score.baseline.warning, /BOOTSTRAP PLACEHOLDER/);
  assert.match(score.baseline.warning, /MUST NOT/);
  assert.equal(score.baseline.warning, BOOTSTRAP_WARNING);
});

test("scoreRanking on a real snapshot carries NO placeholder warning", () => {
  const score = scoreRanking({
    ranked: RANKED,
    groundTruth: { keys: TRUTH },
    baselineSource: BASELINE_REAL,
  });
  assert.equal(score.baseline.source, BASELINE_REAL);
  assert.equal(score.baseline.warning, null);
});

test("a MALFORMED k is surfaced, not silently rewritten to a default", () => {
  // `ks: [1, "x"]` used to collapse to a single entry — the bad input vanished
  // into the fallback instead of failing loudly.
  assert.throws(
    () => scoreRanking({ ranked: RANKED, groundTruth: { keys: TRUTH }, ks: [1, "x"] }),
    /k must be a positive integer/,
  );
  assert.throws(() => precisionAtK(RANKED, TRUTH, "x"), /k must be a positive integer/);
  assert.throws(() => precisionAtK(RANKED, TRUTH, 0), /k must be a positive integer/);
  assert.throws(() => recallAtK(RANKED, TRUTH, -1), /k must be a positive integer/);
  assert.throws(() => recallAtK(RANKED, TRUTH, NaN), /k must be a positive integer/);
});

test("an OMITTED k still takes the documented default", () => {
  // Absent is not malformed: precision with no k scores the whole retrieval.
  assert.equal(precisionAtK(RANKED, TRUTH), 0.25);
  assert.equal(recallAtK(RANKED, TRUTH, null), 1);
  const score = scoreRanking({ ranked: RANKED, groundTruth: { keys: TRUTH } });
  assert.deepEqual(Object.keys(score.precisionAtK), ["1", "3", "5"]);
});
