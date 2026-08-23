// The information-environment check.
//
// The contaminated fixture is not invented — it is trimmed from a real
// `claude -p` run on a developer machine, the run that revealed the whole
// problem. Testing against a hypothetical would have proved nothing; the point
// is that THIS environment must be rejected.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildClaudeArgs,
  collectHookEvents,
  parseInitEvent,
} from "../../src/harness/agent.mjs";
import {
  EXPECTED_MCP_SERVERS,
  FINDING_CWD,
  FINDING_FOREIGN_HOOKS,
  FINDING_MCP_SERVERS,
  FINDING_MISSING_HOOKS,
  FINDING_NO_INIT,
  FINDING_PLUGINS,
  FINDING_SKILLS,
  FINDING_SLASH_COMMANDS,
  assertCleanEnvironment,
  describeEnvironment,
  summarizeEnvironment,
} from "../../src/grading/environment.mjs";
import { MCP_SERVER_NAME } from "../../src/harness/mcp-config.mjs";
import { prepareArm } from "../../src/harness/arm.mjs";
import { withSandbox } from "../../src/sandbox/sandbox.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
);

async function contaminatedInit() {
  return JSON.parse(
    await fsp.readFile(path.join(FIXTURES, "contaminated-init.json"), "utf8"),
  );
}

const CLEAN_INIT = {
  type: "system",
  subtype: "init",
  cwd: "/tmp/lorekit-eval-abc123/cwd",
  model: "claude-opus-4-8",
  permissionMode: "bypassPermissions",
  tools: ["Bash", "Read", "mcp__lorekit__memory_write"],
  mcp_servers: [{ name: "lorekit", status: "connected" }],
  slash_commands: [],
  skills: [],
  plugins: [],
};

test("the real contaminated environment is REJECTED", async () => {
  const init = await contaminatedInit();
  const verdict = assertCleanEnvironment(summarizeEnvironment({ init }));

  assert.equal(verdict.clean, false);
  assert.equal(verdict.verifiable, true);

  const kinds = verdict.findings.map((f) => f.kind);
  assert.ok(kinds.includes(FINDING_SKILLS));
  assert.ok(kinds.includes(FINDING_PLUGINS));
  assert.ok(kinds.includes(FINDING_MCP_SERVERS));
});

test("the skill that gives away the answer is named in the finding", async () => {
  const init = await contaminatedInit();
  const verdict = assertCleanEnvironment(summarizeEnvironment({ init }));
  const skills = verdict.findings.find((f) => f.kind === FINDING_SKILLS);

  // `lorekit-memory`'s SKILL.md states `branch::{owner}/{repo}::{branch}` —
  // the golden task's answer. If it is loaded, arm A is not a control.
  assert.ok(skills.values.includes("lorekit-memory"));
});

test("only the harness's own MCP server is allowed through", async () => {
  const init = await contaminatedInit();
  const verdict = assertCleanEnvironment(summarizeEnvironment({ init }));
  const servers = verdict.findings.find((f) => f.kind === FINDING_MCP_SERVERS);

  assert.equal(servers.values.includes("lorekit"), false, "ours is expected");
  assert.ok(servers.values.includes("argent"));
  assert.ok(servers.values.includes("dash0"));
});

test("a clean environment passes", () => {
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({
      init: CLEAN_INIT,
      hookEvents: [{ name: "SessionStart:startup", event: "SessionStart" }],
    }),
    { sandboxRoot: "/tmp/lorekit-eval-abc123", expectedHooks: 1 },
  );
  assert.equal(verdict.clean, true, JSON.stringify(verdict.findings));
  assert.match(describeEnvironment(verdict), /^environment: clean/);
});

test("five hooks firing when one was installed is contamination", () => {
  // Exactly what the real machine did: the sandbox installs one SessionStart
  // hook, the developer's user settings supply four more.
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({
      init: CLEAN_INIT,
      hookEvents: Array.from({ length: 5 }, (_, i) => ({
        name: `SessionStart:startup-${i}`,
        event: "SessionStart",
      })),
    }),
    { sandboxRoot: "/tmp/lorekit-eval-abc123", expectedHooks: 1 },
  );
  assert.equal(verdict.clean, false);
  assert.ok(verdict.findings.some((f) => f.kind === FINDING_FOREIGN_HOOKS));
});

test("fewer hooks than expected is contamination, not a clean run", () => {
  // The opposite of the five-hook case, and the more dangerous one: the
  // harness's own SessionStart never fired, so no lesson was injected and arm B
  // ran as arm A. Scoring that rep would report "memory does not help".
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({ init: CLEAN_INIT, hookEvents: [] }),
    { sandboxRoot: "/tmp/lorekit-eval-abc123", expectedHooks: 1 },
  );
  assert.equal(verdict.clean, false);
  assert.equal(verdict.verifiable, true, "the init event was there");
  assert.ok(verdict.findings.some((f) => f.kind === FINDING_MISSING_HOOKS));
});

test("a hook firing on another event is foreign even when the count matches", () => {
  // One hook fired, one was expected — arithmetic says clean. It was not ours.
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({
      init: CLEAN_INIT,
      hookEvents: [{ name: "PreToolUse:Bash", event: "PreToolUse" }],
    }),
    { sandboxRoot: "/tmp/lorekit-eval-abc123", expectedHooks: 1 },
  );
  assert.equal(verdict.clean, false);
  assert.ok(verdict.findings.some((f) => f.kind === FINDING_FOREIGN_HOOKS));
});

test("a hook with no recorded event is unknown, never foreign", () => {
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({
      init: CLEAN_INIT,
      hookEvents: [{ name: "SessionStart:startup", event: null }],
    }),
    { sandboxRoot: "/tmp/lorekit-eval-abc123", expectedHooks: 1 },
  );
  assert.equal(verdict.clean, true, JSON.stringify(verdict.findings));
});

test("slash commands in scope are contamination", () => {
  // `--disable-slash-commands` expresses the intent; this is the check that the
  // running `claude` actually honoured it.
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({
      init: { ...CLEAN_INIT, slash_commands: ["compact", "review"] },
      hookEvents: [{ name: "SessionStart:startup", event: "SessionStart" }],
    }),
    { sandboxRoot: "/tmp/lorekit-eval-abc123", expectedHooks: 1 },
  );
  assert.equal(verdict.clean, false);
  const finding = verdict.findings.find(
    (f) => f.kind === FINDING_SLASH_COMMANDS,
  );
  assert.deepEqual(finding.values, ["compact", "review"]);
});

test("the allowed MCP server is the one the harness actually writes", () => {
  // Not a tautology: `EXPECTED_MCP_SERVERS` spelled the name itself once, so
  // renaming the server key flagged every rep as contaminated by its own store.
  assert.deepEqual(EXPECTED_MCP_SERVERS, [MCP_SERVER_NAME]);
});

test("running outside the sandbox is contamination", () => {
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({ init: CLEAN_INIT }),
    { sandboxRoot: "/tmp/some-other-sandbox", expectedHooks: 0 },
  );
  assert.ok(verdict.findings.some((f) => f.kind === FINDING_CWD));
});

test("a sandbox cwd reported as its realpath is inside the sandbox", async () => {
  // `os.tmpdir()` is a symlink on macOS, and the agent reports the resolved
  // form. If the sandbox root were the unresolved `mkdtemp` path, this prefix
  // test would fail for every rep and the whole batch would be discarded as
  // "ran outside the sandbox".
  await withSandbox({}, async (sandbox) => {
    const verdict = assertCleanEnvironment(
      summarizeEnvironment({
        init: { ...CLEAN_INIT, cwd: await fsp.realpath(sandbox.cwd) },
      }),
      { sandboxRoot: sandbox.root, expectedHooks: 0 },
    );
    assert.equal(
      verdict.findings.some((f) => f.kind === FINDING_CWD),
      false,
      JSON.stringify(verdict.findings),
    );
  });
});

test("a missing init event is UNVERIFIABLE, never clean", () => {
  const verdict = assertCleanEnvironment(summarizeEnvironment({ init: null }));
  assert.equal(verdict.clean, false);
  assert.equal(verdict.verifiable, false);
  assert.deepEqual(
    verdict.findings.map((f) => f.kind),
    [FINDING_NO_INIT],
  );
  assert.match(describeEnvironment(verdict), /UNVERIFIABLE/);
});

test("summarizeEnvironment is total over junk", () => {
  const empty = summarizeEnvironment({});
  assert.equal(empty.present, false);
  assert.deepEqual(empty.skills, []);
  assert.deepEqual(empty.mcpServers, []);
  assert.equal(summarizeEnvironment().present, false);
});

test("parseInitEvent finds the init line and ignores the rest", async () => {
  const init = await contaminatedInit();
  const stream = [
    '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}',
    "not json",
    JSON.stringify(init),
    '{"type":"result","subtype":"success"}',
  ].join("\n");

  assert.equal(parseInitEvent(stream).subtype, "init");
  assert.equal(parseInitEvent(""), null);
  assert.equal(parseInitEvent('{"type":"result"}'), null);
});

test("collectHookEvents counts every hook that fired", () => {
  const stream = [
    '{"type":"system","subtype":"hook_started","hook_id":"a","hook_name":"SessionStart:startup","hook_event":"SessionStart"}',
    '{"type":"system","subtype":"hook_started","hook_id":"b","hook_name":"SessionStart:startup","hook_event":"SessionStart"}',
    // A response is not a second firing.
    '{"type":"system","subtype":"hook_response","hook_id":"a"}',
    "garbage",
  ].join("\n");

  const hooks = collectHookEvents(stream);
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].event, "SessionStart");
  assert.deepEqual(collectHookEvents(""), []);
});

test("the argv asks for the isolation it then verifies", () => {
  const args = buildClaudeArgs({ prompt: "x", settingsPath: "/tmp/s.json" });
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(args[args.indexOf("--settings") + 1], "/tmp/s.json");

  // Opt-out exists, because a future arm may want skills in scope.
  const permissive = buildClaudeArgs({
    prompt: "x",
    disableSlashCommands: false,
  });
  assert.equal(permissive.includes("--disable-slash-commands"), false);
  assert.equal(permissive.includes("--settings"), false);
});

test("a prepared arm carries its own launch options", async () => {
  await withSandbox({}, async (sandbox) => {
    const arm = await prepareArm(sandbox, { seed: "canonical" });

    assert.equal(arm.agentOptions.mcpConfigPath, arm.mcp.path);
    assert.equal(arm.agentOptions.disableSlashCommands, true);
    assert.equal(arm.agentOptions.settingsPath, arm.settingsPath);
    // Harness wiring lives outside the working directory.
    assert.equal(arm.settingsPath.startsWith(sandbox.cwd), false);

    const settings = JSON.parse(await fsp.readFile(arm.settingsPath, "utf8"));
    assert.deepEqual(settings.enabledPlugins, {});
    // Crucially NOT `hooks: {}` — `--settings` overrides every scope, so that
    // would switch off the harness's own SessionStart hook and silently turn
    // arm B into arm A.
    assert.equal("hooks" in settings, false);
  });
});
