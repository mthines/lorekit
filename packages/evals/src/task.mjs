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

import { DEFAULT_BRANCH, DEFAULT_OWNER_REPO } from "./git-identity.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
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
    title: "Record a lesson scoped to a specific branch",
    targetScope: TARGET_SCOPE,
    targetKey: TARGET_KEY,
    prompt: goldenPrompt,
    grader: "grade.mjs — exact-match on the stored scope",
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
