import assert from "node:assert/strict";
import { test } from "node:test";

import {
  shouldSurface,
  buildGroundTruth,
  relevanceWeight,
  repoOfScope,
  seenCountOf,
  RECURRENCE_CONFIRMED_AT,
} from "../src/ground-truth.mjs";

// The two real outcome/relevance rows from the in-repo mock, as the store hands
// them back. Copied here as the MINIMAL shape the predicate reads — the full
// mock is exercised by relevance-integration.test.mjs, which imports MEMORY_ROWS
// itself rather than restating it.
const M05 = {
  scope: "repo::mthines/lorekit",
  key: "audit::one-vocabulary",
  tags: ["audit", "loop::reviewer-comment-relevance"],
  origin_pr: 311,
};
const M06 = {
  scope: "repo::mthines/lorekit",
  key: "rls::service-role-user-filter",
  tags: ["security", "rls", "loop::review-outcomes"],
  origin_pr: null,
};
// Non-outcome rows — must be rejected.
const M03 = {
  scope: "repo::mthines/lorekit",
  key: "edge-parity::mirror-pattern",
  tags: ["architecture"],
};
const M04 = {
  scope: "repo::mthines/lorekit",
  key: "scope-format::double-colon",
  tags: ["scope", "validation"],
};

const QUERY = { repo: "mthines/lorekit" };

test("AC-1(a): both outcome/relevance mock rows are selected for the repo query", () => {
  assert.equal(shouldSurface(M05, QUERY), true);
  assert.equal(shouldSurface(M06, QUERY), true);
});

test("AC-1(a): the null-origin_pr outcome row (m06) is kept, not dropped", () => {
  // The spec's match is "origin_pr / repo scope matches" — a disjunction. m06 is
  // a real loop::review-outcomes signal with origin_pr: null; requiring a PR
  // would silently drop it. Locked so a future tightening to a conjunction fails.
  assert.equal(M06.origin_pr, null);
  assert.equal(shouldSurface(M06, QUERY), true);
});

test("AC-1(b): non-outcome rows are rejected", () => {
  assert.equal(shouldSurface(M03, QUERY), false);
  assert.equal(shouldSurface(M04, QUERY), false);
});

test("AC-1(c): membership is decided by the SHIPPED inferKindHost, not a re-encoded tag list", () => {
  // FORBIDDEN PATTERN (the recurring mock-that-reimplements trap): if
  // ground-truth.mjs ever replaced its `import { inferKindHost } from
  // "@lorekit/schemas/tags"` with a LOCAL copy of the `loop::…` → bucket
  // mapping, this predicate would keep passing against these fixtures while
  // silently drifting from the product the day a bucket is added or renamed.
  // The guard against that is structural, asserted by AC-1-reuse (a grep that
  // fails if the literal tags reappear in the module) — proven to bite because
  // the module contains NEITHER literal. Here we assert the BEHAVIOUR that pin
  // protects: a bucket the resolver does not classify as review/reviewer is not
  // ground truth, and a plain lesson bucket is not either.
  const lessonRow = {
    scope: "repo::mthines/lorekit",
    key: "aw::x",
    tags: ["loop::aw-lessons"], // resolves to host "aw" — not an outcome host
  };
  assert.equal(shouldSurface(lessonRow, QUERY), false);
});

test("repo mismatch rejects a real outcome row", () => {
  assert.equal(shouldSurface(M05, { repo: "someone/else" }), false);
});

test("a scope query narrows the same way a repo query does", () => {
  assert.equal(shouldSurface(M05, { scope: "repo::mthines/lorekit" }), true);
  assert.equal(shouldSurface(M05, { scope: "repo::other/repo" }), false);
});

test("origin_pr pins narrow only when the row declares a PR", () => {
  // m05 declares PR 311 → a mismatching pin drops it, a matching pin keeps it.
  assert.equal(shouldSurface(M05, { repo: "mthines/lorekit", origin_pr: 999 }), false);
  assert.equal(shouldSurface(M05, { repo: "mthines/lorekit", origin_pr: 311 }), true);
  // m06 declares no PR → a pin never drops it.
  assert.equal(shouldSurface(M06, { repo: "mthines/lorekit", origin_pr: 999 }), true);
});

test("repoOfScope handles repo:: and branch:: and rejects the rest", () => {
  assert.equal(repoOfScope("repo::mthines/lorekit"), "mthines/lorekit");
  assert.equal(repoOfScope("branch::mthines/lorekit::feat/x"), "mthines/lorekit");
  assert.equal(repoOfScope("global"), null);
  assert.equal(repoOfScope("project::agent-skills"), null);
});

test("seenCountOf reads either shape and never throws", () => {
  assert.equal(seenCountOf({ seenCount: 5 }), 5);
  assert.equal(seenCountOf({ seen_count: 4 }), 4);
  assert.equal(seenCountOf({ seen_count: "7" }), 7);
  assert.equal(seenCountOf({}), 0);
  assert.equal(seenCountOf(null), 0);
  assert.equal(seenCountOf({ seen_count: "not-a-number" }), 0);
});

test("relevanceWeight boosts recurrence-confirmed rows above unconfirmed ones", () => {
  const confirmed = { ...M05, seenCount: RECURRENCE_CONFIRMED_AT };
  const unconfirmed = { ...M06, seenCount: RECURRENCE_CONFIRMED_AT - 1 };
  assert.ok(relevanceWeight(confirmed, QUERY) > relevanceWeight(unconfirmed, QUERY));
  // A non-member always weighs 0.
  assert.equal(relevanceWeight(M03, QUERY), 0);
});

test("buildGroundTruth returns metadata-only entries — never a lesson body", () => {
  const gt = buildGroundTruth([M05, M06, M03, M04], QUERY);
  assert.equal(gt.keys.length, 2);
  assert.deepEqual(new Set(gt.keys), new Set([M05.key, M06.key]));
  for (const entry of gt.entries) {
    assert.equal("value" in entry, false);
    assert.equal("body" in entry, false);
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["key", "origin_pr", "recurrenceConfirmed", "scope", "seenCount", "tags", "weight"],
    );
  }
});
