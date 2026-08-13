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
} from "../src/agent.mjs";
import {
  FINDING_CWD,
  FINDING_FOREIGN_HOOKS,
  FINDING_MCP_SERVERS,
  FINDING_NO_INIT,
  FINDING_PLUGINS,
  FINDING_SKILLS,
  assertCleanEnvironment,
  describeEnvironment,
  summarizeEnvironment,
} from "../src/environment.mjs";
import { prepareArm } from "../src/arm.mjs";
import { withSandbox } from "../src/sandbox.mjs";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
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

test("running outside the sandbox is contamination", () => {
  const verdict = assertCleanEnvironment(
    summarizeEnvironment({ init: CLEAN_INIT }),
    { sandboxRoot: "/tmp/some-other-sandbox", expectedHooks: 0 },
  );
  assert.ok(verdict.findings.some((f) => f.kind === FINDING_CWD));
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
