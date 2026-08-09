import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MISTAKE_BRANCH_WITH_SLASH,
  MISTAKE_SINGLE_COLON,
  SCORE_EXACT,
  SCORE_NOTHING,
  SCORE_RIGHT_REPO_COARSE,
  SCORE_RIGHT_REPO_WRONG_BRANCH,
  SCORE_WROTE_SOMETHING,
  attemptedScopesFromTranscript,
  classifyMistake,
  grade,
  gradeSandbox,
  isValidScope,
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

test("case differences normalize to success — the validator lowercases (AC-3.2)", () => {
  // `validateScope` returns the lowercased form, so an agent that shouted the
  // repo name still produced the canonical scope. Exactness is judged after
  // the canonical normalization, not before it.
  const result = grade({ storedScopes: ["branch::mthines/gw-tools::feat/x"] });
  assert.equal(result.success, true);
  assert.equal(
    grade({ storedScopes: ["BRANCH::mthines/GW-Tools::feat/x"] }).success,
    false,
    "the store holds what was written; an uppercased scope is a different string",
  );
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
