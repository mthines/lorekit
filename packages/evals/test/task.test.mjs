import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TARGET_BRANCH,
  TARGET_KEY,
  TARGET_OWNER_REPO,
  TARGET_SCOPE,
  TASKS,
  canonicalLessonText,
  goldenPrompt,
  specText,
  taskById,
} from "../src/task.mjs";
import { isValidScope } from "../src/grade.mjs";
import { DEFAULT_BRANCH, DEFAULT_OWNER_REPO } from "../src/git-identity.mjs";

test("the target scope is the canonical branch form and is valid (AC-3.3)", () => {
  assert.equal(TARGET_SCOPE, "branch::mthines/gw-tools::feat/x");
  assert.equal(TARGET_SCOPE, `branch::${TARGET_OWNER_REPO}::${TARGET_BRANCH}`);
  assert.equal(isValidScope(TARGET_SCOPE), true);
});

test("the prompt names the repo, branch and key but NOT the scope format", async () => {
  const prompt = goldenPrompt();
  assert.match(prompt, /mthines\/gw-tools/);
  assert.match(prompt, /feat\/x/);
  assert.ok(prompt.includes(TARGET_KEY));
  assert.match(prompt, /memory\.write/);

  // The thing under test must not be in the prompt: no target scope string, no
  // `::`, and no warning that a separator gotcha exists — an agent told to be
  // careful is solving an easier task than a real turn presents.
  assert.equal(prompt.includes(TARGET_SCOPE), false);
  assert.equal(prompt.includes("::"), false);
  assert.equal(/separator|colon/i.test(prompt), false);
});

test("the canonical lesson states the rule without restating the task (AC-3.3)", async () => {
  const lesson = await canonicalLessonText();
  assert.match(lesson, /`::` as the ONLY segment separator/);
  assert.match(lesson, /branch::\{owner\}\/\{repo\}::\{branch\}/);
  // A lesson containing the answer to the exact prompt would measure copying.
  assert.equal(lesson.includes(TARGET_SCOPE), false);
  assert.equal(lesson.includes(TARGET_KEY), false);
});

test("the spec records the target and the rubric (AC-3.3)", async () => {
  const spec = await specText();
  assert.ok(spec.includes(TARGET_SCOPE));
  assert.match(spec, /## Rubric/);
  assert.match(spec, /exact string equality/);
});

test("the task target and the sandbox identity are ONE fact, not two", () => {
  // arm0 refuses to run when the arm's resolved scope is not the graded target,
  // so drift between these pairs would break every run. They must come from a
  // single source rather than agree by coincidence.
  assert.equal(TARGET_OWNER_REPO, DEFAULT_OWNER_REPO);
  assert.equal(TARGET_BRANCH, DEFAULT_BRANCH);
  assert.equal(
    TARGET_SCOPE,
    `branch::${DEFAULT_OWNER_REPO}::${DEFAULT_BRANCH}`,
  );
});

test("the spec says which mistake kinds the seeded lesson actually names", async () => {
  const spec = await specText();
  const lesson = await canonicalLessonText();

  // The lesson names the single-colon and slash-appended forms...
  assert.match(lesson, /branch:owner\/repo/);
  assert.match(lesson, /branch::owner\/repo\/branch/);
  // ...and says nothing about omitting the branch segment, so the spec must not
  // claim `repeatedMistake` always means "the mistake the lesson warned about".
  assert.equal(/omitt|missing/i.test(lesson), false);
  assert.match(spec, /In the lesson\?/);
  assert.match(
    spec,
    /`branch-segment-missing`\s*\|[^|]*\|\s*no\s*\|/,
    "the kinds table must mark branch-segment-missing as absent from the lesson",
  );
});

test("the two alternates are registered as stubs with their grader need (AC-3.4)", () => {
  const stubs = Object.values(TASKS).filter((t) => !t.implemented);
  assert.equal(stubs.length, 2);
  assert.deepEqual(stubs.map((t) => t.id).sort(), [
    "edge-bare-specifier",
    "storybook-hang",
  ]);
  for (const stub of stubs) {
    assert.ok(stub.graderNeed.length > 40, `${stub.id} needs a real note`);
    assert.ok(stub.title.length > 0);
  }
  // Each alternate needs machinery the primary grader does not have.
  assert.match(TASKS["storybook-hang"].graderNeed, /HARD TIMEOUT/);
  assert.match(TASKS["edge-bare-specifier"].graderNeed, /BOOT-OUTPUT/);
});

test("taskById refuses a stub instead of running an empty eval (AC-3.4)", () => {
  assert.equal(taskById("branch-scope").id, "branch-scope");
  assert.throws(() => taskById("storybook-hang"), /is a stub/);
  assert.throws(() => taskById("storybook-hang"), /HARD TIMEOUT/);
  assert.throws(() => taskById("nope"), /unknown task/);
});
