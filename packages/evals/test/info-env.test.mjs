// The information-environment control (AC-2.4).
//
// The experiment's only independent variable is whether the store is populated.
// If the working directory itself explains the gotcha, arm A scores like arm B
// and the harness reports "memory does not help" having measured nothing at
// all. So the spoiler scan is an assertion, not a convenience.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { installedHookEvents } from "@lorekit/cli/src/config.mjs";

import { prepareArm } from "../bin/run-eval.mjs";
import { initGitIdentity } from "../src/git-identity.mjs";
import { withSandbox } from "../src/sandbox.mjs";

/** Phrases that would give the branch-scope gotcha away. */
const SPOILERS = ["::", "double colon", "separator"];

test("a prepared arm's cwd contains no gotcha-spoiling document (AC-2.4)", async () => {
  await withSandbox({}, async (sandbox) => {
    // A repo checkout would routinely carry these; the sandbox must not.
    await fsp.writeFile(
      path.join(sandbox.cwd, "CLAUDE.md"),
      "Scopes use `::` as the separator. Example: branch::owner/repo::branch",
    );

    await prepareArm(sandbox, { seed: "canonical" });

    const hits = await sandbox.findSpoilers(SPOILERS);
    assert.deepEqual(hits, [], `unexpected spoilers: ${JSON.stringify(hits)}`);
  });
});

test("findSpoilers actually detects a spoiler when one is present", async () => {
  // An assertion that can never fail is not an assertion — prove the scanner
  // sees the thing it is supposed to guard against.
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    await fsp.writeFile(
      path.join(sandbox.cwd, "notes.md"),
      "remember: the separator is a double colon",
    );

    const hits = await sandbox.findSpoilers(SPOILERS);
    assert.ok(hits.length > 0);
    assert.equal(hits[0].file, "notes.md");
    assert.ok(hits.some((h) => h.term === "double colon"));
  });
});

test("findSpoilers ignores the sandbox's own git wiring", async () => {
  await withSandbox({}, async (sandbox) => {
    await initGitIdentity(sandbox.cwd);
    // `.git/config` holds the origin URL, which is deliberate wiring rather
    // than content the agent reads — scanning it would produce noise forever.
    const hits = await sandbox.findSpoilers(["gw-tools"]);
    assert.deepEqual(hits, []);
  });
});

test("findSpoilers with no terms is a no-op rather than a full-tree read", async () => {
  await withSandbox({}, async (sandbox) => {
    assert.deepEqual(await sandbox.findSpoilers([]), []);
  });
});

test("the MCP config never lands where the agent could read it as context", async () => {
  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, { seed: "canonical" });
    assert.equal(arm.mcp.path.startsWith(sandbox.cwd), false);

    const entries = await fsp.readdir(sandbox.cwd);
    // `.claude/settings.json` (the hook) is the only harness file in the cwd,
    // and it names no lesson content.
    assert.deepEqual(entries.sort(), [".claude", ".git"]);
  });
});

test("both memory arms are prepared identically except for the store (AC-2.4)", async () => {
  const shapeOf = async (seed) => {
    let shape;
    await withSandbox({}, async (sandbox) => {
      const arm = await prepareArm(sandbox, { seed });
      const entries = (await fsp.readdir(sandbox.cwd)).sort();
      shape = {
        entries,
        readOrder: arm.derived.readOrder,
        allowedTools: arm.mcp.allowedTools,
        // Read back from the sandbox's own settings.json, not from the
        // constant installSessionStartHook echoes — comparing that to itself
        // is an assertion that can never fail.
        hookEvents: installedHookEvents(sandbox.cwd, "project"),
        server: JSON.stringify(arm.mcp.config.mcpServers.lorekit.args),
        seededCount: arm.seeded.seeded.length,
      };
    });
    return shape;
  };

  const armA = await shapeOf("empty");
  const armB = await shapeOf("canonical");

  assert.deepEqual(armA.entries, armB.entries);
  assert.deepEqual(armA.readOrder, armB.readOrder);
  assert.deepEqual(armA.allowedTools, armB.allowedTools);
  assert.deepEqual(armA.hookEvents, armB.hookEvents);
  assert.equal(armA.server, armB.server);
  // The one and only difference.
  assert.equal(armA.seededCount, 0);
  assert.equal(armB.seededCount, 1);
});
