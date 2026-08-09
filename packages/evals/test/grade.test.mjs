import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MISTAKE_BRANCH_MISSING,
  MISTAKE_BRANCH_WITH_SLASH,
  MISTAKE_SINGLE_COLON,
  SCORE_EXACT,
  SCORE_NOTHING,
  SCORE_RIGHT_REPO_COARSE,
  SCORE_RIGHT_REPO_WRONG_BRANCH,
  SCORE_RIGHT_SCOPE_WRONG_FORM,
  SCORE_WROTE_SOMETHING,
  attemptedScopesFromTranscript,
  classifyMistake,
  grade,
  gradeSandbox,
  isValidScope,
  normalizeScope,
  repoOf,
} from "../src/grade.mjs";
import { TARGET_KEY, TARGET_SCOPE } from "../src/task.mjs";
import { withSandbox } from "../src/sandbox.mjs";
import { seedLesson } from "../src/store-setup.mjs";

// AC-3.1: the rubric, over hand-written store states.
const CASES = [
  {
    name: "exact",
    storedScopes: [TARGET_SCOPE],
    success: true,
    score: SCORE_EXACT,
    repeatedMistake: false,
  },
  {
    name: "exact among others still succeeds",
    storedScopes: ["global", TARGET_SCOPE],
    success: true,
    score: SCORE_EXACT,
    repeatedMistake: false,
  },
  {
    name: "single-colon",
    storedScopes: ["branch:mthines/gw-tools"],
    success: false,
    score: SCORE_WROTE_SOMETHING,
    repeatedMistake: true,
  },
  {
    name: "branch appended with a slash",
    storedScopes: ["branch::mthines/gw-tools/feat/x"],
    success: false,
    score: SCORE_WROTE_SOMETHING,
    repeatedMistake: true,
  },
  {
    name: "wrong order",
    storedScopes: ["branch::feat/x::mthines/gw-tools"],
    success: false,
    score: SCORE_WROTE_SOMETHING,
    repeatedMistake: false,
  },
  {
    name: "right repo, wrong branch",
    storedScopes: ["branch::mthines/gw-tools::main"],
    success: false,
    score: SCORE_RIGHT_REPO_WRONG_BRANCH,
    repeatedMistake: false,
  },
  {
    name: "right repo, coarser granularity",
    storedScopes: ["repo::mthines/gw-tools"],
    success: false,
    score: SCORE_RIGHT_REPO_COARSE,
    repeatedMistake: false,
  },
  {
    name: "unrelated scope",
    storedScopes: ["global"],
    success: false,
    score: SCORE_WROTE_SOMETHING,
    repeatedMistake: false,
  },
  {
    name: "absent",
    storedScopes: [],
    success: false,
    score: SCORE_NOTHING,
    repeatedMistake: false,
  },
];

for (const c of CASES) {
  test(`grade: ${c.name} (AC-3.1)`, () => {
    const result = grade({ storedScopes: c.storedScopes });
    assert.equal(result.success, c.success, "success");
    assert.equal(result.score, c.score, "score");
    assert.equal(result.repeatedMistake, c.repeatedMistake, "repeatedMistake");
    assert.equal(typeof result.detail, "string");
    assert.ok(result.detail.length > 0);
  });
}

test("success is judged BEFORE normalization — case differences do not succeed (AC-3.2)", () => {
  // `validateScope` lowercases, so a shouted scope is *valid* and normalizes to
  // the target — but the offline store holds the string that was written, and
  // success is exact equality with that. The old name for this test claimed the
  // opposite of what it asserts.
  assert.equal(isValidScope("BRANCH::mthines/GW-Tools::feat/x"), true);
  assert.equal(
    normalizeScope("BRANCH::mthines/GW-Tools::feat/x"),
    TARGET_SCOPE,
    "the validator folds the case away",
  );
  assert.equal(
    grade({ storedScopes: ["BRANCH::mthines/GW-Tools::feat/x"] }).success,
    false,
    "the store holds what was written; an uppercased scope is a different string",
  );
  // The verbatim target is the only shape that succeeds.
  assert.equal(grade({ storedScopes: [TARGET_SCOPE] }).success, true);
});

test("a scope that only normalizes to the target is 80, never the wrong-branch band", () => {
  // The rubric reserves 60 for a branch that ACTUALLY differs. A case- or
  // whitespace-only variant names the right branch, so grading it 60 with a
  // "wrong branch" detail would misreport what the agent did.
  for (const variant of [
    "BRANCH::mthines/GW-Tools::feat/x",
    `  ${TARGET_SCOPE}  `,
  ]) {
    const result = grade({ storedScopes: [variant] });
    assert.equal(result.success, false, variant);
    assert.equal(result.score, SCORE_RIGHT_SCOPE_WRONG_FORM, variant);
    assert.equal(result.matchedScope, variant);
    assert.match(result.detail, /normalizes to the target/);
    assert.doesNotMatch(result.detail, /wrong branch/);
  }

  // A genuinely different branch still lands on 60.
  const wrongBranch = grade({
    storedScopes: ["branch::mthines/gw-tools::main"],
  });
  assert.equal(wrongBranch.score, SCORE_RIGHT_REPO_WRONG_BRANCH);
  assert.match(wrongBranch.detail, /wrong branch/);
});

test("a single-colon scope grades invalid AND repeated-mistake (AC-3.2)", () => {
  const result = grade({ storedScopes: ["branch:mthines/gw-tools"] });
  assert.equal(isValidScope("branch:mthines/gw-tools"), false);
  assert.equal(result.repeatedMistake, true);
  assert.deepEqual(result.mistakes, [
    { scope: "branch:mthines/gw-tools", kind: MISTAKE_SINGLE_COLON },
  ]);
  assert.equal(result.success, false);
});

test("partial credit NEVER becomes success", () => {
  for (const c of CASES.filter((x) => !x.success)) {
    const result = grade({ storedScopes: c.storedScopes });
    assert.equal(result.success, false, c.name);
    assert.ok(result.score < SCORE_EXACT, c.name);
  }
});

test("a rejected attempt is a mistake even though it left no trace", () => {
  // The hosted store rejects an invalid scope outright, so it exists only in
  // the transcript. The grader must still see it.
  const result = grade({
    storedScopes: [TARGET_SCOPE],
    attemptedScopes: ["branch:mthines/gw-tools", TARGET_SCOPE],
  });
  assert.equal(result.success, true, "the retry recovered");
  assert.equal(result.repeatedMistake, true, "but the mistake happened");
});

test("classifyMistake only ever classifies INVALID scopes", () => {
  assert.equal(
    classifyMistake("branch:mthines/gw-tools"),
    MISTAKE_SINGLE_COLON,
  );
  assert.equal(classifyMistake("repo:mthines/gw-tools"), MISTAKE_SINGLE_COLON);
  assert.equal(
    classifyMistake("branch::mthines/gw-tools/feat/x"),
    MISTAKE_BRANCH_WITH_SLASH,
  );
  // Omitting the branch entirely is a DIFFERENT recall failure from appending
  // it with a slash, and the mistakes list must not report a slash that was
  // never written.
  assert.equal(
    classifyMistake("branch::mthines/gw-tools"),
    MISTAKE_BRANCH_MISSING,
  );
  // Not even an `owner/repo` — invalid for an unrelated reason.
  assert.equal(classifyMistake("branch::mthines"), null);
  // Valid scopes are never mistakes, however they look.
  assert.equal(classifyMistake(TARGET_SCOPE), null);
  assert.equal(classifyMistake("global"), null);
  assert.equal(classifyMistake("repo::mthines/gw-tools"), null);
  // Invalid for an unrelated reason.
  assert.equal(classifyMistake("branch::feat/x::mthines/gw-tools"), null);
  assert.equal(classifyMistake(""), null);
  assert.equal(classifyMistake(null), null);
});

test("repoOf reads the repo out of both scope shapes", () => {
  assert.equal(repoOf(TARGET_SCOPE), "mthines/gw-tools");
  assert.equal(repoOf("repo::mthines/gw-tools"), "mthines/gw-tools");
  assert.equal(repoOf("global"), null);
  assert.equal(repoOf("branch:mthines/gw-tools"), null);
});

test("attemptedScopesFromTranscript reads memory_write inputs in order", () => {
  const transcript = [
    JSON.stringify({ type: "system", subtype: "init" }),
    "definitely not json",
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__lorekit__memory_write",
            input: { scope: "branch:mthines/gw-tools", key: "k" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "that failed, retrying" },
          {
            type: "tool_use",
            // A different server label must still match — suffix, not equality.
            name: "mcp__other__memory_write",
            input: { scope: TARGET_SCOPE, key: "k" },
          },
          {
            type: "tool_use",
            name: "mcp__lorekit__memory_read",
            input: { scope: "global", key: "k" },
          },
        ],
      },
    }),
  ].join("\n");

  assert.deepEqual(attemptedScopesFromTranscript(transcript), [
    "branch:mthines/gw-tools",
    TARGET_SCOPE,
  ]);
  assert.deepEqual(attemptedScopesFromTranscript(""), []);
  assert.deepEqual(attemptedScopesFromTranscript(null), []);
  assert.deepEqual(attemptedScopesFromTranscript('{"type":"assistant"}'), []);
});

test("gradeSandbox enumerates the store rather than probing known scopes", async () => {
  await withSandbox({}, async (sandbox) => {
    // Somewhere nobody would have thought to look.
    await seedLesson(sandbox, {
      scope: "project::somewhere-unexpected",
      key: TARGET_KEY,
      value: "the agent chose its own scope",
    });

    const result = await gradeSandbox(sandbox);
    assert.equal(result.success, false);
    assert.equal(result.score, SCORE_WROTE_SOMETHING);
    assert.deepEqual(result.storedScopes, ["project::somewhere-unexpected"]);
  });
});

test("gradeSandbox scores a real successful write (AC-3.1)", async () => {
  await withSandbox({}, async (sandbox) => {
    await seedLesson(sandbox, {
      scope: TARGET_SCOPE,
      key: TARGET_KEY,
      value: "seeded integration db",
    });
    const result = await gradeSandbox(sandbox);
    assert.equal(result.success, true);
    assert.equal(result.score, SCORE_EXACT);
    assert.equal(result.matchedScope, TARGET_SCOPE);
  });
});

test("gradeSandbox catches the offline store accepting an invalid scope", async () => {
  // The offline store performs NO scope validation, so the gotcha lands in the
  // store instead of being rejected. Verified here rather than assumed, because
  // the grader's two-source design depends on it.
  await withSandbox({}, async (sandbox) => {
    await seedLesson(sandbox, {
      scope: "branch:mthines/gw-tools",
      key: TARGET_KEY,
      value: "written with one colon and accepted offline",
    });
    const result = await gradeSandbox(sandbox);
    assert.equal(result.success, false);
    assert.equal(result.repeatedMistake, true);
    assert.equal(result.mistakes[0].kind, MISTAKE_SINGLE_COLON);
  });
});

test("an empty sandbox grades zero, not an error", async () => {
  await withSandbox({}, async (sandbox) => {
    const result = await gradeSandbox(sandbox);
    assert.equal(result.score, SCORE_NOTHING);
    assert.equal(result.success, false);
    assert.deepEqual(result.storedScopes, []);
  });
});
