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
  // Skills and slash commands are auto-discovered from `~/.claude/skills`, so a
  // developer's own installs load into every run. On this repo that is not a
  // hypothetical: `lorekit-memory` is a globally installed skill whose SKILL.md
  // states the canonical scope format — the literal answer to the golden task —
  // so arm A would score full marks with an empty store and the experiment
  // would measure nothing. Disabled by default; the arms have no use for
  // skills anyway.
  disableSlashCommands = true,
  // An inline/overriding settings file. Used to switch off enabled plugins,
  // which are another auto-discovered source of instructions.
  settingsPath = null,
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
  if (disableSlashCommands) args.push("--disable-slash-commands");
  if (settingsPath) args.push("--settings", settingsPath);
  return [...args, ...extraArgs];
}

/**
 * The `{"type":"system","subtype":"init"}` event, which every stream-json run
 * emits first. It enumerates what the session actually loaded — `skills`,
 * `plugins`, `mcp_servers`, `tools`, `slash_commands`, `cwd`, `model` — and is
 * therefore the ONLY trustworthy account of the environment a rep ran in.
 * Flags express intent; this records the outcome.
 */
export function parseInitEvent(transcriptText) {
  if (typeof transcriptText !== "string" || transcriptText === "") return null;
  for (const line of transcriptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry && entry.type === "system" && entry.subtype === "init") {
      return entry;
    }
  }
  return null;
}

/**
 * Every hook the session fired, from the `hook_started` events in the stream.
 *
 * Hooks are not listed in the init event, and a developer's user-level
 * `~/.claude/settings.json` hooks fire alongside the sandbox's own — five of
 * them did on the machine that first ran this harness. Counting them is how an
 * arm proves that exactly one hook (ours) injected anything.
 */
export function collectHookEvents(transcriptText) {
  if (typeof transcriptText !== "string" || transcriptText === "") return [];
  const hooks = [];
  for (const line of transcriptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry && entry.type === "system" && entry.subtype === "hook_started") {
      hooks.push({
        id: entry.hook_id || null,
        name: entry.hook_name || null,
        event: entry.hook_event || null,
      });
    }
  }
  return hooks;
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
 */
export function summarizeResult(resultJson) {
  const usage = (resultJson && resultJson.usage) || {};
  return {
    isError: Boolean(resultJson && resultJson.is_error),
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

  const { code, signal } = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c, s) => resolve({ code: c, signal: s }));
  }).finally(() => clearTimeout(killTimer));

  await new Promise((resolve) => stream.end(resolve));

  const wallMs = Date.now() - startedAt;
  const transcriptText = await fsp
    .readFile(transcriptPath, "utf8")
    .catch(() => "");
  const resultJson = parseResultLine(transcriptText);

  return {
    resultJson,
    summary: summarizeResult(resultJson),
    // What the session ACTUALLY loaded, as opposed to what the flags asked for.
    init: parseInitEvent(transcriptText),
    hookEvents: collectHookEvents(transcriptText),
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
