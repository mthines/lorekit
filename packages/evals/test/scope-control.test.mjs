// Scope is chosen, not derived — and the harness must be able to prove it.
//
// A LoreKit scope is an explicit argument to `memory.write`; nothing in the CLI
// derives one. Git decides only which scopes a DIRECTORY discovers, via
// `deriveScope` → `readOrder` → the SessionStart hook. These tests pin both
// halves, because the experiment's readability depends on the difference:
// a lesson that was never injected did not fail on its merits.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { deriveScope } from "@lorekit/cli/src/scope.mjs";

import {
  GIT_DEPENDENT_SCOPE_MODES,
  SCOPE_MODES,
  assertArmInjectable,
  nominalScopeForMode,
  prepareArm,
  requiresGit,
  requiresGitForScope,
  scopeForMode,
} from "../src/arm.mjs";
import { DEFAULT_BRANCH, DEFAULT_OWNER_REPO } from "../src/git-identity.mjs";
import { readInjectedLessons } from "../src/hook-install.mjs";
import {
  RETRIEVAL_ABSENT,
  RETRIEVAL_INJECTED,
  RETRIEVAL_IN_STORE_NOT_LOADED,
  attributeFailure,
  classifyRetrieval,
} from "../src/retrieval.mjs";
import { withSandbox } from "../src/sandbox.mjs";
import { CANONICAL_LESSON, listAll, seedLesson } from "../src/store-setup.mjs";

const BRANCH_SCOPE = `branch::${DEFAULT_OWNER_REPO}::${DEFAULT_BRANCH}`;

test("a scope can be written with no git anywhere in sight", async () => {
  await withSandbox({}, async (sandbox) => {
    // No git identity at all — every scope form still writes successfully,
    // because the scope is an argument, not something derived from the cwd.
    for (const scope of [
      "global",
      "project::anything",
      `repo::${DEFAULT_OWNER_REPO}`,
      BRANCH_SCOPE,
    ]) {
      await seedLesson(sandbox, {
        scope,
        key: `k-${scope.replace(/[^a-z]/g, "")}`,
        value: `a lesson at ${scope}`,
      });
    }
    const entries = await listAll(sandbox, [
      "global",
      "project::anything",
      `repo::${DEFAULT_OWNER_REPO}`,
      BRANCH_SCOPE,
    ]);
    assert.equal(entries.length, 4);
  });
});

test("git decides only what a directory DISCOVERS", async () => {
  await withSandbox({}, async (sandbox) => {
    const withoutGit = deriveScope(sandbox.cwd);
    assert.deepEqual(withoutGit.readOrder, [
      `project::${path.basename(sandbox.cwd).toLowerCase()}`,
      "global",
    ]);
    assert.equal(withoutGit.branchScope, null);
    assert.equal(withoutGit.repoScope, null);

    const arm = await prepareArm(sandbox, {
      seed: "empty",
      scopeMode: "branch",
    });
    assert.equal(arm.gitInitialized, true);
    assert.ok(arm.derived.readOrder.includes(BRANCH_SCOPE));
    assert.ok(arm.derived.readOrder.includes(`repo::${DEFAULT_OWNER_REPO}`));
  });
});

test("only branch and repo modes need a git identity", () => {
  assert.deepEqual(GIT_DEPENDENT_SCOPE_MODES, ["branch", "repo"]);
  assert.equal(requiresGit("branch"), true);
  assert.equal(requiresGit("repo"), true);
  assert.equal(requiresGit("project"), false);
  assert.equal(requiresGit("global"), false);
  assert.deepEqual(SCOPE_MODES, ["branch", "repo", "project", "global"]);
});

test("scopeForMode reads the modes off a derived scope, and rejects nonsense", () => {
  const derived = deriveScope(process.cwd());
  assert.equal(scopeForMode(derived, "global"), "global");
  assert.equal(scopeForMode(derived, "project"), derived.projectScope);
  assert.throws(() => scopeForMode(derived, "nope"), TypeError);
});

test("a global-scoped arm injects with NO git — the scope-resolution control", async () => {
  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, {
      seed: "canonical",
      scopeMode: "global",
    });

    assert.equal(arm.gitInitialized, false);
    assert.equal(arm.targetScope, "global");
    assert.equal(arm.injectable, true);

    const injection = await readInjectedLessons(sandbox);
    assert.equal(injection.lessons.length, 1);
    assert.equal(injection.lessons[0].key, CANONICAL_LESSON.key);
    assert.equal(injection.lessons[0].scope, "global");
  });
});

test("a branch-scoped lesson with no git is stored but NEVER injected", async () => {
  // The failure mode the whole scope-control change exists to make visible:
  // the write succeeds, the hook sees nothing, and a naive harness would score
  // this as "memory did not help".
  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, {
      seed: "canonical",
      scopeMode: "branch",
      git: false,
    });

    assert.equal(arm.gitInitialized, false);
    assert.equal(arm.targetScope, BRANCH_SCOPE);
    assert.equal(arm.injectable, false);
    assert.equal(arm.seeded.seeded.length, 1); // the write SUCCEEDED

    const injection = await readInjectedLessons(sandbox);
    assert.deepEqual(injection.lessons, []);

    const stored = await listAll(sandbox, [BRANCH_SCOPE]);
    assert.equal(stored.length, 1);

    const retrieval = classifyRetrieval({
      injection,
      storeEntries: stored,
      key: CANONICAL_LESSON.key,
      scope: BRANCH_SCOPE,
    });
    assert.equal(retrieval.state, RETRIEVAL_IN_STORE_NOT_LOADED);
    assert.equal(retrieval.inStore, true);
    assert.equal(retrieval.injected, false);
    assert.equal(retrieval.harnessFault, false);
    // A failure here is a RETRIEVAL failure — the lesson's content is not on
    // trial, so it must never be reported as "memory did not help".
    assert.equal(attributeFailure({ retrieval, success: false }), "retrieval");
  });
});

test("the same lesson WITH git is injected — utilization is then on trial", async () => {
  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, {
      seed: "canonical",
      scopeMode: "branch",
    });
    assert.equal(arm.injectable, true);

    const injection = await readInjectedLessons(sandbox);
    const stored = await listAll(sandbox, [BRANCH_SCOPE]);
    const retrieval = classifyRetrieval({
      injection,
      storeEntries: stored,
      key: CANONICAL_LESSON.key,
    });

    assert.equal(retrieval.state, RETRIEVAL_INJECTED);
    assert.equal(retrieval.position, 1);
    assert.equal(
      attributeFailure({ retrieval, success: false }),
      "utilization",
    );
    assert.equal(attributeFailure({ retrieval, success: true }), null);
  });
});

test("an unseeded lesson is a HARNESS fault, not a negative result", () => {
  const retrieval = classifyRetrieval({
    injection: { lessons: [] },
    storeEntries: [],
    key: "never-written",
  });
  assert.equal(retrieval.state, RETRIEVAL_ABSENT);
  assert.equal(retrieval.harnessFault, true);
  // Crucially NOT "utilization" or "retrieval" — this rep must be discarded.
  assert.equal(attributeFailure({ retrieval, success: false }), "harness");
});

test("classifyRetrieval records the observed position, never a derived one", () => {
  const retrieval = classifyRetrieval({
    injection: {
      lessons: [
        { position: 1, key: "other", scope: "global" },
        { position: 2, key: "wanted", scope: "global" },
      ],
    },
    storeEntries: [{ key: "wanted", scope: "global" }],
    key: "wanted",
  });
  assert.equal(retrieval.position, 2);
  assert.equal(retrieval.injectedCount, 2);
});

test("a same-key lesson INJECTED from another scope is not the seeded one", () => {
  // The injected set spans the whole `readOrder`, so the scope filter has to
  // apply to both lookups or a foreign hit reads as the seeded lesson.
  const retrieval = classifyRetrieval({
    injection: {
      lessons: [{ position: 1, key: "wanted", scope: "global" }],
    },
    storeEntries: [{ key: "wanted", scope: BRANCH_SCOPE }],
    key: "wanted",
    scope: BRANCH_SCOPE,
  });
  assert.equal(retrieval.state, RETRIEVAL_IN_STORE_NOT_LOADED);
  assert.equal(retrieval.injected, false);
  assert.equal(retrieval.inStore, true);
  // The foreign lesson still counts towards what the agent actually saw.
  assert.equal(retrieval.injectedCount, 1);
});

test("a same-key entry at another scope is ABSENT, not in-store-not-loaded", () => {
  // `runProbe` gathers `storeEntries` across every scope in `readOrder`, so
  // without the seeded scope this reads as a retrieval failure when it is in
  // fact a harness fault — the exact confusion the module exists to prevent.
  const retrieval = classifyRetrieval({
    injection: { lessons: [] },
    storeEntries: [{ key: "wanted", scope: "global" }],
    key: "wanted",
    scope: BRANCH_SCOPE,
  });
  assert.equal(retrieval.state, RETRIEVAL_ABSENT);
  assert.equal(retrieval.inStore, false);
  assert.equal(retrieval.harnessFault, true);

  // Omitting the scope keeps the pre-existing key-only behaviour.
  const unscoped = classifyRetrieval({
    injection: { lessons: [] },
    storeEntries: [{ key: "wanted", scope: "global" }],
    key: "wanted",
  });
  assert.equal(unscoped.state, RETRIEVAL_IN_STORE_NOT_LOADED);
});

test("classifyRetrieval requires a key rather than guessing", () => {
  assert.throws(
    () => classifyRetrieval({ injection: { lessons: [] } }),
    TypeError,
  );
});

test("prepareArm rejects an unknown seed or scope mode up front", async () => {
  await withSandbox({}, async (sandbox) => {
    await assert.rejects(
      () => prepareArm(sandbox, { seed: "nope" }),
      TypeError,
    );
    await assert.rejects(
      () => prepareArm(sandbox, { scopeMode: "nope" }),
      TypeError,
    );
    // An explicit scope does not buy a pass on the mode: `parseArgs` rejects
    // the same value, so accepting it here would be the only silent path.
    await assert.rejects(
      () => prepareArm(sandbox, { scope: "global", scopeMode: "nope" }),
      TypeError,
    );
  });
});

test("an explicit scope overrides the mode", async () => {
  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, {
      seed: "canonical",
      scope: "global",
      git: false,
    });
    assert.equal(arm.scopeMode, "explicit");
    assert.equal(arm.targetScope, "global");
  });
});

test("an explicit scope also decides the git default, not the ignored mode", async () => {
  // `scopeMode` still defaults to `branch` here; the explicit scope overrides
  // it, so the git default must follow the scope actually used.
  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, {
      seed: "canonical",
      scope: "global",
    });
    assert.equal(arm.scopeMode, "explicit");
    assert.equal(arm.gitInitialized, false);
    assert.equal(arm.injectable, true);
  });

  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, {
      seed: "empty",
      scopeMode: "global",
      scope: BRANCH_SCOPE,
    });
    assert.equal(arm.gitInitialized, true);
    assert.equal(arm.injectable, true);
  });
});

test("assertArmInjectable rejects an unreachable scope and passes a reachable arm through", async () => {
  // The deliberately-broken arm: a branch scope seeded in a directory that
  // derives no branch scope at all. The assertion is the caller's opt-in guard
  // against making that mistake by accident.
  await withSandbox({}, async (sandbox) => {
    const unreachable = await prepareArm(sandbox, {
      seed: "canonical",
      scopeMode: "branch",
      git: false,
    });
    assert.equal(unreachable.injectable, false);
    assert.throws(
      () => assertArmInjectable(unreachable),
      /does not derive the required scope/,
    );
  });

  await withSandbox({}, async (sandbox) => {
    const reachable = await prepareArm(sandbox, {
      seed: "canonical",
      scopeMode: "global",
    });
    assert.equal(reachable.injectable, true);
    // Returns the arm itself, so it can be used inline at a call site.
    assert.equal(assertArmInjectable(reachable), reachable);
  });
});

test("nominalScopeForMode types every mode, and rejects nonsense", () => {
  const opts = {
    ownerRepo: DEFAULT_OWNER_REPO,
    branch: DEFAULT_BRANCH,
    cwd: "/tmp/Some-Sandbox-Dir",
  };
  assert.equal(nominalScopeForMode("branch", opts), BRANCH_SCOPE);
  assert.equal(
    nominalScopeForMode("repo", opts),
    `repo::${DEFAULT_OWNER_REPO}`,
  );
  assert.equal(
    nominalScopeForMode("project", opts),
    "project::some-sandbox-dir",
  );
  assert.equal(nominalScopeForMode("global", opts), "global");
  // Both separators, per the docblock — a Windows-shaped path resolves the same.
  assert.equal(
    nominalScopeForMode("project", { ...opts, cwd: "C:\\tmp\\Sandbox" }),
    "project::sandbox",
  );
  assert.throws(() => nominalScopeForMode("nope", opts), TypeError);
});

test("requiresGitForScope mirrors requiresGit for a scope string", () => {
  assert.equal(requiresGitForScope(BRANCH_SCOPE), true);
  assert.equal(requiresGitForScope(`repo::${DEFAULT_OWNER_REPO}`), true);
  assert.equal(requiresGitForScope("project::anything"), false);
  assert.equal(requiresGitForScope("global"), false);
});
