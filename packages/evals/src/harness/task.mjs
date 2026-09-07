// The task registry.
//
// One task is real; two are stubs. The stubs are registered rather than merely
// mentioned in a document because a task the harness cannot name is a task
// nobody will build — and because each one records, at the point where it would
// be implemented, the specific grader machinery it needs that the primary task
// does not.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BRANCH,
  DEFAULT_OWNER_REPO,
} from "../sandbox/git-identity.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
);

/**
 * The repository and branch the golden task is about.
 *
 * Re-exported from `git-identity.mjs` rather than restated: the task targets
 * the identity the sandbox is GIVEN, so these are one fact with two names, not
 * two facts that happen to agree. arm0 refuses to run when the arm's resolved
 * scope is not the graded target, which would turn any drift between the two
 * pairs into a hard failure of every run.
 */
export const TARGET_OWNER_REPO = DEFAULT_OWNER_REPO;
export const TARGET_BRANCH = DEFAULT_BRANCH;

/** The one string a successful attempt must produce, verbatim. */
export const TARGET_SCOPE = `branch::${TARGET_OWNER_REPO}::${TARGET_BRANCH}`;

/**
 * The OFF-TARGET task's target: the same repository, one granularity coarser.
 *
 * The variant experiment needs a second task the lesson is NOT about, so a
 * framing that helps on `branch-scope` can be charged for what it costs
 * elsewhere. This is that task, and it is deliberately a NEIGHBOUR rather than
 * a stranger: it asks for the repo-wide scope in the same directory, which is
 * the exact situation where an over-emphatic branch lesson misfires by writing
 * `branch::…` when `repo::…` was asked.
 *
 * That misfire needs no new grader — `grade.mjs` already scores "branch scope
 * for the right repo" at 60 against a `repo::` target, which is precisely the
 * over-application band. A grader-free second task is why this axis is cheap.
 */
export const OFF_TARGET_SCOPE = `repo::${TARGET_OWNER_REPO}`;

/** The key the off-target task asks for. No `::`, for the same reason. */
export const OFF_TARGET_KEY = "eval-repo-wide-convention";

/**
 * The key the task asks for, so the grader knows what to look up.
 *
 * Deliberately contains NO `::`. Most LoreKit keys are written
 * `namespace::name`, but the prompt quotes this key verbatim — and putting a
 * `::` in the prompt would hand the agent the very separator the task is
 * testing whether it remembers. Caught by a test, not by inspection.
 */
export const TARGET_KEY = "eval-branch-scope-gotcha";

/**
 * The prompt.
 *
 * It states the repository, the branch and the key, and says nothing about the
 * scope FORMAT — that is the thing under test. It also does not hint that a
 * format gotcha exists: an agent warned to be careful about separators would be
 * solving a different, easier task than the one a real turn presents.
 *
 * It asks for a `memory.write` explicitly because the alternative — letting the
 * agent choose a mechanism — would measure tool selection as well as recall,
 * and the arms would no longer differ in one variable.
 */
export function goldenPrompt({
  ownerRepo = TARGET_OWNER_REPO,
  branch = TARGET_BRANCH,
  key = TARGET_KEY,
} = {}) {
  return [
    `Use the lorekit memory.write tool to record a short lesson.`,
    ``,
    `The lesson applies specifically to the "${branch}" branch of the`,
    `"${ownerRepo}" repository — not to the repository as a whole, and not`,
    `globally. Scope it accordingly.`,
    ``,
    `Use the key "${key}". For the value, write one or two sentences saying`,
    `that integration tests on this branch must be run against a seeded`,
    `database, because an empty one makes them pass for the wrong reason.`,
    ``,
    `When the write succeeds, reply with the scope string you used and nothing`,
    `else.`,
  ].join("\n");
}

/**
 * The off-target prompt.
 *
 * Deliberately the SAME SHAPE as `goldenPrompt` — same instruction to use
 * `memory.write`, same "reply with the scope string" ending — so the two tasks
 * differ in what they ask for and in nothing else. A differently-worded prompt
 * would make the off-target result a fact about the prompt style rather than
 * about the lesson's reach.
 *
 * It says "not to any one branch" explicitly. Without that, writing a branch
 * scope would be a defensible reading of the request, and the over-application
 * band would stop meaning over-application.
 */
export function offTargetPrompt({
  ownerRepo = TARGET_OWNER_REPO,
  key = OFF_TARGET_KEY,
} = {}) {
  return [
    `Use the lorekit memory.write tool to record a short lesson.`,
    ``,
    `The lesson applies to the "${ownerRepo}" repository as a whole — to every`,
    `branch of it, not to any one branch, and not globally. Scope it`,
    `accordingly.`,
    ``,
    `Use the key "${key}". For the value, write one or two sentences saying`,
    `that this repository pins its formatter version in the lockfile, because`,
    `a floating version reformats unrelated files on every contributor's`,
    `machine.`,
    ``,
    `When the write succeeds, reply with the scope string you used and nothing`,
    `else.`,
  ].join("\n");
}

/** The curated gold lesson body, read from the fixture. */
export async function canonicalLessonText() {
  const file = path.join(FIXTURES, "canonical-lesson.md");
  return (await fsp.readFile(file, "utf8")).trim();
}

/** The task spec, for artifact provenance — a run records what it ran. */
export async function specText() {
  return fsp.readFile(path.join(FIXTURES, "spec.md"), "utf8");
}

/**
 * The primary task, plus the two alternates as explicit stubs.
 *
 * `implemented: false` is load-bearing: `taskById` refuses to hand back an
 * unimplemented task, so a future caller gets a clear error naming the missing
 * grader rather than a silently-empty run.
 */
export const TASKS = {
  "branch-scope": {
    id: "branch-scope",
    implemented: true,
    // What the lesson under test is ABOUT. Every variant should help here.
    role: "on-target",
    title: "Record a lesson scoped to a specific branch",
    targetScope: TARGET_SCOPE,
    targetKey: TARGET_KEY,
    prompt: goldenPrompt,
    grader: "grade.mjs — exact-match on the stored scope",
  },

  "repo-scope": {
    id: "repo-scope",
    implemented: true,
    // What the lesson is NOT about. A variant that helps here is not credited;
    // one that HURTS here is charged in full, because every session pays for
    // the lesson whether or not the turn is the one it was written for.
    role: "off-target",
    title: "Record a lesson scoped to the whole repository",
    targetScope: OFF_TARGET_SCOPE,
    targetKey: OFF_TARGET_KEY,
    prompt: offTargetPrompt,
    grader:
      "grade.mjs — exact-match on the stored scope; the 60 band (branch scope " +
      "for the right repo) IS the over-application signal here",
  },

  "storybook-hang": {
    id: "storybook-hang",
    implemented: false,
    title: "Run the Storybook interaction tests without hanging the turn",
    // `npx`/`pnpm exec`/`nx run` keep the Playwright browser child's stdio
    // open, so the process never returns (see the repo's own note on invoking
    // those suites with plain `npx`).
    graderNeed:
      "a HARD TIMEOUT grader: the failure is a process that never exits, so " +
      "success is a bounded wall-clock completion and the grader must tell " +
      "'hung' apart from 'slow'. The exact-match grader has no notion of either.",
  },

  "edge-bare-specifier": {
    id: "edge-bare-specifier",
    implemented: false,
    title: "Add an edge function import without breaking its boot",
    // A bare specifier in a Deno edge function resolves only via an import map
    // that no longer exists; the symptom is an opaque 503 BOOT_ERROR.
    graderNeed:
      "a BOOT-OUTPUT grader: the failure surfaces only when the function is " +
      "started, so the grader must run it and parse startup stderr rather " +
      "than inspect the store. Nothing about it is visible in a memory entry.",
  },
};

/** Look up a task, refusing the stubs rather than running an empty eval. */
export function taskById(id) {
  const task = TASKS[id];
  if (!task) {
    throw new Error(
      `unknown task "${id}"; known: ${Object.keys(TASKS).join(", ")}`,
    );
  }
  if (!task.implemented) {
    throw new Error(
      `task "${id}" is a stub, not runnable yet — it needs ${task.graderNeed}`,
    );
  }
  return task;
}
