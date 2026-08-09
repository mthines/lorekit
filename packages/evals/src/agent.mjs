// The agent under test: headless Claude Code (`claude -p`).
//
// Everything that knows the shape of the `claude` CLI lives here. When the CLI
// changes its flags or its stream format, exactly one module and its fixture
// test fail — not the whole suite.
//
// Output format (OQ-4, resolved by construction):
//   `--output-format stream-json --verbose` writes the FULL event stream, one
//   JSON object per line, and its final `{"type":"result",...}` line carries
//   what `--output-format json` would have returned on its own (num_turns,
//   usage, total_cost_usd, duration_ms, is_error, result). One run therefore
//   yields both artifacts the harness needs:
//     • the JSONL stream → `detectFriction` (PR4), which reads
//       `entry.message.content[]` for `tool_use` / `tool_result.is_error`
//       exactly as it does for a Claude Code session transcript;
//     • the final result line → turns, tokens, cost, wall time.
//   Taking `json` instead would force a second run to recover the stream, which
//   would not be the same run. `outputFormat` stays overridable so a `claude`
//   version that renames the flag can be pinned without editing callers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * The model under test. Fixed by the experimental design — ONE constant, so a
 * model change is a one-line diff and can never differ between arms.
 */
export const MODEL_UNDER_TEST = "claude-opus-4-8";

/** Default hard wall-clock ceiling for a single attempt. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Grace period between SIGTERM and SIGKILL when a run times out. */
export const KILL_GRACE_MS = 5_000;

export const DEFAULT_OUTPUT_FORMAT = "stream-json";

/**
 * Build the `claude` argv. Pure, so the flag contract is unit-testable without
 * spawning anything.
 */
export function buildClaudeArgs({
  prompt,
  model = MODEL_UNDER_TEST,
  outputFormat = DEFAULT_OUTPUT_FORMAT,
  mcpConfigPath = null,
  strictMcpConfig = true,
  allowedTools = [],
  permissionMode = "bypassPermissions",
  extraArgs = [],
} = {}) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new TypeError("buildClaudeArgs: prompt must be a non-empty string");
  }
  const args = [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    outputFormat,
  ];
  // `stream-json` on stdout requires --verbose; without it the CLI refuses.
  if (outputFormat === "stream-json") args.push("--verbose");
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
    // Only the servers the harness declared may load, so a developer's personal
    // ~/.claude.json cannot leak a second memory server into an arm.
    if (strictMcpConfig) args.push("--strict-mcp-config");
  }
  if (allowedTools.length > 0)
    args.push("--allowed-tools", allowedTools.join(","));
  if (permissionMode) args.push("--permission-mode", permissionMode);
  return [...args, ...extraArgs];
}

/**
 * Pick the final `{"type":"result"}` object out of a stream-json transcript.
 * Tolerates partial/non-JSON lines. Returns null when absent (e.g. a killed run).
 */
export function parseResultLine(transcriptText) {
  if (typeof transcriptText !== "string" || transcriptText.length === 0)
    return null;
  const lines = transcriptText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry && entry.type === "result") return entry;
  }
  return null;
}

/**
 * Normalize the result line into the fields the metrics module consumes, so a
 * rename upstream is absorbed here rather than in every metric.
 *
 * A MISSING result line is an error, not a clean run. A timed-out or crashed
 * attempt has no `{"type":"result"}` line at all, and reporting
 * `isError: false` for it let a failed rep be counted as a success by any
 * metric that did not additionally consult `timedOut`/`exitCode`. `hasResult`
 * is reported alongside so a metric can still tell the two apart — the agent
 * reporting an error is not the same event as the agent never reporting.
 */
export function summarizeResult(resultJson) {
  const usage = (resultJson && resultJson.usage) || {};
  const hasResult = Boolean(resultJson);
  return {
    hasResult,
    isError: hasResult ? Boolean(resultJson.is_error) : true,
    subtype: (resultJson && resultJson.subtype) || null,
    numTurns:
      resultJson && typeof resultJson.num_turns === "number"
        ? resultJson.num_turns
        : null,
    durationMs:
      resultJson && typeof resultJson.duration_ms === "number"
        ? resultJson.duration_ms
        : null,
    costUsd:
      resultJson && typeof resultJson.total_cost_usd === "number"
        ? resultJson.total_cost_usd
        : null,
    inputTokens:
      typeof usage.input_tokens === "number" ? usage.input_tokens : null,
    outputTokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : null,
    text:
      resultJson && typeof resultJson.result === "string"
        ? resultJson.result
        : null,
  };
}

/**
 * Spawn one headless attempt and capture it.
 *
 * @returns {Promise<{
 *   resultJson: object|null, summary: object, transcriptPath: string,
 *   transcriptText: string, stderr: string, exitCode: number|null,
 *   signal: string|null, timedOut: boolean, wallMs: number, argv: string[],
 * }>}
 */
export async function runAgent({
  prompt,
  cwd,
  env = process.env,
  transcriptPath,
  command = "claude",
  // Argv prefixed BEFORE the claude flags. Its only purpose is to let a test
  // substitute a scripted stand-in (`node fake-claude.mjs …`) while the flag
  // contract under test stays exactly the one production builds.
  commandArgs = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...argOptions
} = {}) {
  if (!cwd)
    throw new TypeError("runAgent: cwd is required (runs must be sandboxed)");
  if (!transcriptPath)
    throw new TypeError("runAgent: transcriptPath is required");

  const args = [...commandArgs, ...buildClaudeArgs({ prompt, ...argOptions })];
  await fsp.mkdir(path.dirname(transcriptPath), { recursive: true });

  const startedAt = Date.now();
  const stream = fs.createWriteStream(transcriptPath, { flags: "w" });
  let stderr = "";
  let timedOut = false;

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const killTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, timeoutMs);

  // `error` (e.g. `claude` not on PATH) rejects this promise, so the transcript
  // stream has to be closed in the SAME `finally` as the timer — closing it
  // after the await only ever ran on the success path, leaking an open file
  // descriptor for every failed spawn. `finally` awaits a returned promise, so
  // the stream is flushed before either outcome is observed.
  //
  // Waiting on `close`, not on `end()`'s callback, is the load-bearing half:
  // that callback fires on `finish` — the bytes are flushed but the descriptor
  // is released later — so `runAgent` could still return with the transcript fd
  // open, which is exactly what the leak regression test observes (and did,
  // intermittently, on CI). `close` is the fd-released signal. The `closed`
  // guard covers the success path, where `pipe` already ended and auto-destroyed
  // the stream: there the event has fired and waiting for it would hang.
  const { code, signal } = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c, s) => resolve({ code: c, signal: s }));
  }).finally(() => {
    clearTimeout(killTimer);
    return new Promise((resolve) => {
      if (stream.closed) {
        resolve();
        return;
      }
      stream.once("close", resolve);
      stream.end();
    });
  });

  const wallMs = Date.now() - startedAt;
  const transcriptText = await fsp
    .readFile(transcriptPath, "utf8")
    .catch(() => "");
  const resultJson = parseResultLine(transcriptText);

  return {
    resultJson,
    summary: summarizeResult(resultJson),
    transcriptPath,
    transcriptText,
    stderr,
    exitCode: code,
    signal,
    timedOut,
    wallMs,
    argv: [command, ...args],
  };
}
