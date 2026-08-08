import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_TIMEOUT_MS,
  MODEL_UNDER_TEST,
  buildClaudeArgs,
  parseResultLine,
  runAgent,
  summarizeResult,
} from "../src/agent.mjs";
import { withSandbox } from "../src/sandbox.mjs";

test("the model under test is pinned in exactly one constant (AC-1.2)", () => {
  assert.equal(MODEL_UNDER_TEST, "claude-opus-4-8");
  const args = buildClaudeArgs({ prompt: "hi" });
  assert.equal(args[args.indexOf("--model") + 1], MODEL_UNDER_TEST);
});

test("buildClaudeArgs emits the headless contract (AC-1.2)", () => {
  const args = buildClaudeArgs({ prompt: "do the thing" });
  assert.deepEqual(args.slice(0, 2), ["-p", "do the thing"]);
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  // stream-json on stdout is rejected by the CLI without --verbose.
  assert.ok(args.includes("--verbose"));
});

test("buildClaudeArgs omits --verbose for the plain json format", () => {
  const args = buildClaudeArgs({ prompt: "x", outputFormat: "json" });
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args.includes("--verbose"), false);
});

test("buildClaudeArgs wires an isolated MCP config strictly (seam for AC-2.1)", () => {
  const args = buildClaudeArgs({
    prompt: "x",
    mcpConfigPath: "/tmp/s/.mcp.json",
    allowedTools: ["mcp__lorekit__memory_search", "mcp__lorekit__memory_list"],
  });
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/s/.mcp.json");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(
    args[args.indexOf("--allowed-tools") + 1],
    "mcp__lorekit__memory_search,mcp__lorekit__memory_list",
  );
});

test("buildClaudeArgs rejects an empty prompt", () => {
  assert.throws(() => buildClaudeArgs({ prompt: "" }), TypeError);
  assert.throws(() => buildClaudeArgs({}), TypeError);
});

test("parseResultLine picks the last result line and tolerates junk", () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    "not json at all",
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"num_turns":4}',
    "",
  ].join("\n");
  assert.equal(parseResultLine(stream).num_turns, 4);
  assert.equal(parseResultLine(""), null);
  assert.equal(parseResultLine('{"type":"assistant"}'), null);
});

test("summarizeResult normalizes the fields metrics consume", () => {
  const summary = summarizeResult({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 7,
    duration_ms: 1234,
    total_cost_usd: 0.42,
    result: "READY",
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  assert.deepEqual(summary, {
    isError: false,
    subtype: "success",
    numTurns: 7,
    durationMs: 1234,
    costUsd: 0.42,
    inputTokens: 100,
    outputTokens: 20,
    text: "READY",
  });
});

test("summarizeResult degrades to nulls on a missing result line", () => {
  const summary = summarizeResult(null);
  assert.equal(summary.isError, false);
  assert.equal(summary.numTurns, null);
  assert.equal(summary.costUsd, null);
});

test("runAgent captures the stream, result and wall time (AC-1.2)", async () => {
  await withSandbox({}, async (sandbox) => {
    // A scripted stand-in for `claude`: it echoes the prompt it was given and
    // the LOREKIT_HOME it inherited, so the test proves both the argv contract
    // and that the child really runs inside the scratch store.
    const fake = path.join(sandbox.root, "fake-claude.mjs");
    await fsp.writeFile(
      fake,
      [
        "const args = process.argv.slice(2);",
        'const prompt = args[args.indexOf("-p") + 1];',
        'process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");',
        'process.stderr.write("warming up\\n");',
        "process.stdout.write(JSON.stringify({",
        '  type: "result", subtype: "success", is_error: false, num_turns: 2,',
        "  usage: { input_tokens: 5, output_tokens: 1 },",
        '  result: prompt + "|" + process.env.LOREKIT_HOME + "|" + process.env.LOREKIT_MODE,',
        '}) + "\\n");',
      ].join("\n"),
    );

    const transcriptPath = path.join(sandbox.artifacts, "transcript.jsonl");
    const run = await runAgent({
      prompt: "READY",
      cwd: sandbox.cwd,
      env: sandbox.childEnv(),
      transcriptPath,
      command: process.execPath,
      commandArgs: [fake],
      timeoutMs: 30_000,
    });

    assert.equal(run.exitCode, 0);
    assert.equal(run.timedOut, false);
    assert.equal(run.transcriptPath, transcriptPath);
    assert.equal(run.summary.numTurns, 2);
    assert.equal(run.summary.inputTokens, 5);
    assert.equal(run.summary.text, `READY|${sandbox.lorekitHome}|local`);
    assert.match(run.stderr, /warming up/);
    assert.ok(run.wallMs >= 0);

    // The stream is on disk as JSONL, which is what detectFriction reads (PR4).
    const onDisk = await fsp.readFile(transcriptPath, "utf8");
    assert.match(onDisk, /"type":"system"/);
    assert.equal(onDisk.trim().split("\n").length, 2);

    // The model flag really reached the child.
    assert.ok(run.argv.includes(MODEL_UNDER_TEST));
  });
});

test("runAgent enforces its hard wall-clock timeout", async () => {
  await withSandbox({}, async (sandbox) => {
    // A stand-in that never exits: a hung agent must be killed by the harness,
    // not left to burn the run budget.
    const hang = path.join(sandbox.root, "hang.mjs");
    await fsp.writeFile(hang, "setInterval(() => {}, 1000);\n");

    const transcriptPath = path.join(sandbox.artifacts, "hang.jsonl");
    const run = await runAgent({
      prompt: "hang",
      cwd: sandbox.cwd,
      env: sandbox.childEnv(),
      transcriptPath,
      command: process.execPath,
      commandArgs: [hang],
      timeoutMs: 300,
    });
    assert.equal(run.timedOut, true);
    assert.ok(run.wallMs >= 250);
    assert.equal(run.resultJson, null);
  });
});

test("a failed spawn rejects without leaking the transcript stream", async (t) => {
  // The stream used to be closed AFTER the await, so only the success path ever
  // reached it: `claude` not being on PATH emitted `error`, rejected, and left
  // an open file descriptor behind for every attempt.
  if (!fs.existsSync("/proc/self/fd")) {
    t.skip("fd accounting needs /proc");
    return;
  }
  await withSandbox({}, async (sandbox) => {
    const transcriptPath = path.join(sandbox.artifacts, "never-spawned.jsonl");
    await assert.rejects(() =>
      runAgent({
        prompt: "x",
        cwd: sandbox.cwd,
        env: sandbox.childEnv(),
        transcriptPath,
        command: path.join(sandbox.root, "definitely-not-a-binary"),
        timeoutMs: 5_000,
      }),
    );

    const openPaths = fs.readdirSync("/proc/self/fd").map((fd) => {
      try {
        return fs.readlinkSync(path.join("/proc/self/fd", fd));
      } catch {
        return "";
      }
    });
    assert.equal(
      openPaths.includes(transcriptPath),
      false,
      "the transcript stream is still open after the spawn failed",
    );
  });
});

test("runAgent refuses to run outside a sandbox", async () => {
  await assert.rejects(
    () => runAgent({ prompt: "x", transcriptPath: "/tmp/t.jsonl" }),
    TypeError,
  );
  await assert.rejects(() => runAgent({ prompt: "x", cwd: "/tmp" }), TypeError);
});

test("DEFAULT_TIMEOUT_MS is a sane ceiling", () => {
  assert.ok(DEFAULT_TIMEOUT_MS >= 60_000);
});
