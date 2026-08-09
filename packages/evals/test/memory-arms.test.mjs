// The memory arms end to end, WITHOUT a model.
//
// Everything below the agent — the store, the hook, the scopes, the injected
// index — is deterministic, so these are real assertions rather than the "live
// smoke" the plan expected. That matters: if arm B's lesson silently stops
// being injected, this suite fails on the PR instead of the experiment quietly
// measuring nothing three weeks later.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { CLAUDE_HOOK_EVENTS } from "@lorekit/cli/src/config.mjs";

import { prepareArm } from "../bin/run-eval.mjs";
import {
  DEFAULT_BRANCH,
  DEFAULT_OWNER_REPO,
  assertScopesAvailable,
  initGitIdentity,
} from "../src/git-identity.mjs";
import {
  READ_ONLY_EVENTS,
  installSessionStartHook,
  parseInjectedIndex,
  positionOf,
  readInjectedLessons,
} from "../src/hook-install.mjs";
import { withSandbox } from "../src/sandbox.mjs";
import {
  CANONICAL_LESSON,
  empty,
  listAll,
  seedCanonical,
  seedMany,
  seedOrganic,
} from "../src/store-setup.mjs";

const TARGET_SCOPE = `branch::${DEFAULT_OWNER_REPO}::${DEFAULT_BRANCH}`;

test("the sandbox derives the scopes the golden task depends on", async () => {
  await withSandbox({}, async (sandbox) => {
    const scope = await initGitIdentity(sandbox.cwd);
    assert.equal(scope.ownerRepo, DEFAULT_OWNER_REPO);
    assert.equal(scope.branchScope, TARGET_SCOPE);
    assert.ok(scope.readOrder.includes(TARGET_SCOPE));
    assert.ok(scope.readOrder.includes(`repo::${DEFAULT_OWNER_REPO}`));
    assertScopesAvailable(scope, [TARGET_SCOPE]);
  });
});

test("a sandbox with no git identity fails loudly rather than reading nothing", async () => {
  await withSandbox({}, async (sandbox) => {
    // No initGitIdentity — the branch scope does not exist here.
    const { deriveScope } = await import("@lorekit/cli/src/scope.mjs");
    const scope = deriveScope(sandbox.cwd);
    assert.equal(scope.branchScope, null);
    assert.throws(
      () => assertScopesAvailable(scope, [TARGET_SCOPE]),
      /does not derive the required scope/,
    );
  });
});

test("seedCanonical writes exactly one readable lesson (AC-2.3)", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    const { seeded } = await seedCanonical(sandbox, { scope: TARGET_SCOPE });

    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].key, CANONICAL_LESSON.key);

    const entries = await listAll(sandbox, [TARGET_SCOPE]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, CANONICAL_LESSON.key);
    assert.match(entries[0].value, /`::` as the ONLY segment separator/);
  });
});

test("seedOrganic stores the agent's own words verbatim (AC-2.3)", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    const text = "i used branch:owner/repo and it was rejected; use :: twice.";
    await seedOrganic(sandbox, { scope: TARGET_SCOPE, value: text });

    const entries = await listAll(sandbox, [TARGET_SCOPE]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, text);
  });
});

test("seedOrganic refuses an empty arm-0 lesson", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    await assert.rejects(
      () => seedOrganic(sandbox, { scope: TARGET_SCOPE, value: "  " }),
      TypeError,
    );
  });
});

test("empty() asserts the control arm really is a control (AC-2.3)", async () => {
  await withSandbox({}, async (sandbox) => {
    const scope = await initGitIdentity(sandbox.cwd);
    await empty(sandbox, { scopes: scope.readOrder }); // passes on a fresh store

    await seedCanonical(sandbox, { scope: TARGET_SCOPE });
    await assert.rejects(
      () => empty(sandbox, { scopes: scope.readOrder }),
      /expected an empty store/,
    );
  });
});

test("the hook block is the canonical one and prunes the nudges (AC-2.2)", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    const installed = installSessionStartHook(sandbox);

    const settings = JSON.parse(fs.readFileSync(installed.file, "utf8"));
    assert.deepEqual(Object.keys(settings.hooks), READ_ONLY_EVENTS);

    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /hook --adapter claude --event SessionStart --dir/);
    assert.match(command, /\$\{CLAUDE_PROJECT_DIR\}/);
    assert.match(command, /packages\/cli\/bin\/lorekit\.mjs/);

    // Read-only means read-only: the two nudge events must be absent.
    for (const event of CLAUDE_HOOK_EVENTS.filter(
      (e) => !READ_ONLY_EVENTS.includes(e),
    )) {
      assert.equal(settings.hooks[event], undefined, event);
    }
  });
});

test("installing the hook twice never duplicates it", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    installSessionStartHook(sandbox);
    const installed = installSessionStartHook(sandbox);
    const settings = JSON.parse(fs.readFileSync(installed.file, "utf8"));
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionStart[0].hooks.length, 1);
  });
});

test("the seeded lesson really appears in the hook's injected set (AC-2.2)", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    await seedCanonical(sandbox, { scope: TARGET_SCOPE });
    installSessionStartHook(sandbox);

    const injection = await readInjectedLessons(sandbox);
    assert.equal(injection.exitCode, 0);
    assert.match(injection.header, /^LoreKit: 1 memory loaded/);
    assert.equal(injection.declaredCount, 1);
    assert.equal(injection.lessons.length, 1);
    assert.equal(injection.lessons[0].key, CANONICAL_LESSON.key);
    assert.equal(injection.lessons[0].scope, TARGET_SCOPE);

    const where = positionOf(injection, CANONICAL_LESSON.key);
    assert.deepEqual(where, {
      injected: true,
      position: 1,
      scope: TARGET_SCOPE,
    });
  });
});

test("an empty store injects nothing — arm A really is memory-free (AC-2.4)", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    installSessionStartHook(sandbox);

    const injection = await readInjectedLessons(sandbox);
    assert.equal(injection.exitCode, 0);
    assert.equal(injection.additionalContext, null);
    assert.deepEqual(injection.lessons, []);
    assert.deepEqual(positionOf(injection, "anything"), {
      injected: false,
      position: null,
      scope: null,
    });
  });
});

test("position is OBSERVED from the injected set, not assumed (seam for AC-5.3)", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    await seedMany(sandbox, [
      {
        scope: TARGET_SCOPE,
        key: "pad-a",
        value: "an unrelated lesson about A",
      },
      {
        scope: TARGET_SCOPE,
        key: "pad-b",
        value: "an unrelated lesson about B",
      },
      { scope: TARGET_SCOPE, ...CANONICAL_LESSON },
    ]);
    installSessionStartHook(sandbox);

    const injection = await readInjectedLessons(sandbox);
    assert.equal(injection.lessons.length, 3);

    const where = positionOf(injection, CANONICAL_LESSON.key);
    assert.equal(where.injected, true);
    // Deliberately NOT asserted as a specific number: the ordering rule is what
    // the relevance change will alter, and the harness must record whatever the
    // hook chose rather than expect today's answer.
    assert.ok(where.position >= 1 && where.position <= 3);
    assert.deepEqual(
      injection.lessons.map((l) => l.position),
      [1, 2, 3],
    );
  });
});

test("parseInjectedIndex is total over odd hook output", () => {
  assert.deepEqual(parseInjectedIndex(""), {
    header: null,
    declaredCount: null,
    lessons: [],
  });
  assert.deepEqual(parseInjectedIndex(null).lessons, []);

  const parsed = parseInjectedIndex(
    [
      "LoreKit: 2 memories loaded · repo::o/r — considerations, not rules.",
      "- (global) a-key — a hook — with an em dash inside it",
      "not a lesson line",
      "- (branch::o/r::b) b-key — another hook",
      "",
      "Project instruction: focus on migration safety",
    ].join("\n"),
  );
  assert.equal(parsed.declaredCount, 2);
  assert.equal(parsed.lessons.length, 2);
  assert.equal(parsed.lessons[0].key, "a-key");
  assert.equal(parsed.lessons[0].hook, "a hook — with an em dash inside it");
  assert.equal(parsed.lessons[1].scope, "branch::o/r::b");
  assert.equal(parsed.lessons[1].position, 2);
});

test("an unrecognised seed fails loudly rather than silently becoming arm A", async () => {
  await withSandbox({}, async (sandbox) => {
    await assert.rejects(
      () => prepareArm(sandbox, { seed: "cannonical" }),
      /seed must be one of empty, canonical, organic, got cannonical/,
    );
  });
});
