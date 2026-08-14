import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildGroundTruth } from "../src/ground-truth.mjs";
import {
  scoreRanking,
  BASELINE_BOOTSTRAP,
} from "../src/relevance-metrics.mjs";
// Import the REAL mock, not a copy. This is the whole point of the "reuse, not
// re-implementation" invariant: the ground truth is derived from the same rows
// the dashboard stories render, so a change to the mock's outcome/relevance rows
// is caught here rather than silently diverging from a hand-maintained list.
//
// Reached through the PACKAGE specifier, not a `../../web/…` relative path, and
// declared as a devDependency in this package's package.json — the same
// convention cross-package-imports.test.mjs uses for `@lorekit/core/src/scope.ts`.
// The edge is real either way (the module pulls in `msw`); declaring it keeps it
// visible to the workspace graph instead of smuggling it past the manifest.
import { MEMORY_ROWS } from "@lorekit/web/src/mocks/memories.ts";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);
const SEED = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "ground-truth.seed.json"), "utf8"),
);

const QUERY = { repo: "mthines/lorekit" };

test("AC-3: ground truth derived from the real MEMORY_ROWS mock is exactly the 2 outcome rows", () => {
  const gt = buildGroundTruth(MEMORY_ROWS, QUERY);
  assert.equal(gt.keys.length, 2);
  assert.deepEqual(
    new Set(gt.keys),
    new Set(["audit::one-vocabulary", "rls::service-role-user-filter"]),
  );
});

test("AC-3: the committed seed fixture matches what the mock derives (no drift)", () => {
  // The seed is a frozen snapshot of the mock's outcome rows. If someone edits
  // the mock's outcome/relevance rows without refreshing the seed, this fails —
  // keeping ONE source of truth without a fragile cross-package import in the
  // hot path (the seed is what the harness actually reads by default).
  const gt = buildGroundTruth(MEMORY_ROWS, QUERY);
  const derivedKeys = new Set(gt.keys);
  const seedKeys = new Set(SEED.entries.map((e) => e.key));
  assert.deepEqual(seedKeys, derivedKeys);
  // Every seed entry is metadata-only and matches the mock's scope/tags/pr.
  for (const seedEntry of SEED.entries) {
    const mockRow = MEMORY_ROWS.find((r) => r.key === seedEntry.key);
    assert.ok(mockRow, `seed key ${seedEntry.key} exists in the mock`);
    assert.equal(seedEntry.scope, mockRow.scope);
    assert.deepEqual(seedEntry.tags, mockRow.tags);
    assert.equal(seedEntry.origin_pr, mockRow.origin_pr);
    assert.equal("value" in seedEntry, false);
  }
});

test("AC-3: scoring a ranking against the bootstrap ground truth carries the placeholder baseline", () => {
  const gt = buildGroundTruth(MEMORY_ROWS, QUERY);

  // A retriever that ranks the two true rows first among the repo's rows.
  const repoRows = MEMORY_ROWS.filter((r) => r.scope === "repo::mthines/lorekit");
  const ranked = [
    ...gt.keys,
    ...repoRows.map((r) => r.key).filter((k) => !gt.keys.includes(k)),
  ];

  const score = scoreRanking({
    ranked,
    groundTruth: gt,
    ks: [1, 2, 5],
    baselineSource: BASELINE_BOOTSTRAP,
  });

  // Both true rows ranked at the top → a perfect score on this tiny corpus.
  assert.equal(score.mrr, 1);
  assert.equal(score.precisionAtK[2], 1);
  assert.equal(score.recallAtK[2], 1);

  // The load-bearing assertion for R2/R8: the baseline is loudly a placeholder.
  assert.equal(score.baseline.source, "bootstrap-seed");
  assert.equal(score.baseline.rowCount, 2);
  assert.match(score.baseline.warning, /BOOTSTRAP PLACEHOLDER/);
  assert.match(score.baseline.warning, /MUST NOT/);
});
