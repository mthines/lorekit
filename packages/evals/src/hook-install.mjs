// Install the real SessionStart hook into the sandbox, and read back what it
// actually injects.
//
// The wiring is NOT hand-written here. `upsertClaudeHooks` from
// `packages/cli/src/config.mjs` is exported and already writes the canonical
// block into `<root>/.claude/settings.json`; passing `['SessionStart']` also
// PRUNES the other two events, which is what makes this a genuine read-only
// install rather than an additive one that leaves the nudges firing. Calling it
// keeps the harness in lockstep with `CLAUDE_HOOK_EVENTS` by construction — a
// hand-written block would need a drift test, and a drift test only tells you
// about the drift after it has already skewed a run.
//
// The read-back matters just as much as the install. Arm B's premise is that
// the pertinent lesson is IN the injected set; PR4's retrieval metric and PR5's
// position axis both depend on knowing what the hook really emitted, for this
// store, in this working directory. So the harness runs the hook exactly as
// Claude Code would — same binary, same stdin contract — and parses its output,
// rather than predicting it from the ordering rules in `core/lessons.mjs`. That
// prediction is precisely what the forthcoming relevance change invalidates.
import { spawn } from "node:child_process";

import {
  CLAUDE_HOOK_EVENTS,
  settingsPath,
  upsertClaudeHooks,
} from "@lorekit/cli/src/config.mjs";

import { LOREKIT_BIN } from "./paths.mjs";

/** Read-only install: SessionStart injects; nothing ever nudges or writes. */
export const READ_ONLY_EVENTS = ["SessionStart"];

/**
 * The `runner` token embedded in the hook command. `process.execPath <bin>` so
 * the sandbox runs THIS checkout's hook rather than whatever `lorekit` happens
 * to be on `PATH`.
 */
export function hookRunner(bin = LOREKIT_BIN) {
  return `${process.execPath} ${bin}`;
}

/**
 * Wire the SessionStart hook into the sandbox's project settings.
 * @returns {{ file: string, events: string[], command: string }}
 */
export function installSessionStartHook(sandbox, { bin = LOREKIT_BIN } = {}) {
  const runner = hookRunner(bin);
  const result = upsertClaudeHooks(
    sandbox.cwd,
    "project",
    runner,
    READ_ONLY_EVENTS,
  );
  return {
    ...result,
    file: settingsPath(sandbox.cwd, "project"),
    events: [...READ_ONLY_EVENTS],
    prunedEvents: CLAUDE_HOOK_EVENTS.filter(
      (e) => !READ_ONLY_EVENTS.includes(e),
    ),
    runner,
  };
}

/**
 * Parse the SessionStart index block into structured entries.
 *
 * The hook emits one terse line per lesson — `- (scope) key — hook` — under a
 * `LoreKit: N memories loaded` header (`formatLessons` in
 * `packages/cli/src/core/lessons.mjs`). `position` is 1-based and reflects the
 * ORDER THE HOOK CHOSE, which is the whole point: it is observed, never
 * derived from an ordering rule the harness assumes.
 */
export function parseInjectedIndex(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { header: null, declaredCount: null, lessons: [] };
  }
  const lines = text.split("\n");
  const header = lines.find((l) => l.startsWith("LoreKit:")) || null;
  const declared = header && header.match(/LoreKit:\s+(\d+)\s+memor/);
  const lessons = [];
  for (const line of lines) {
    // The separator is an em dash; the hook text itself may contain one, so the
    // match is anchored on the leading `- (scope) key ` shape: the key is a
    // single non-space token, so the FIRST em dash after it ends the key field
    // and any later one stays inside the captured hook text.
    const m = line.match(/^-\s+\(([^)]+)\)\s+(\S+)\s+—\s*([\s\S]*)$/);
    if (!m) continue;
    lessons.push({
      position: lessons.length + 1,
      scope: m[1],
      key: m[2],
      hook: m[3].trim(),
    });
  }
  return {
    header,
    declaredCount: declared ? Number(declared[1]) : null,
    lessons,
  };
}

/**
 * Run the real SessionStart hook against the sandbox and return what it
 * injected. No model is involved, so this is a genuine automated check rather
 * than a live smoke: the hook is a deterministic function of the store and the
 * working directory.
 *
 * A unique `sessionId` per call is required by `firstTimeThisSession`
 * (`core/state.mjs`), which suppresses a second read for the same session —
 * reusing one would make a probe silently return nothing.
 */
export async function readInjectedLessons(
  sandbox,
  {
    sessionId = `eval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    bin = LOREKIT_BIN,
  } = {},
) {
  const payload = JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    cwd: sandbox.cwd,
  });

  const { stdout, stderr, code } = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        bin,
        "hook",
        "--adapter",
        "claude",
        "--event",
        "SessionStart",
        "--dir",
        sandbox.cwd,
      ],
      {
        cwd: sandbox.cwd,
        env: sandbox.childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (c) => resolve({ stdout: out, stderr: err, code: c }));
    child.stdin.end(payload);
  });

  // The hook always exits 0 by design (it must never break its host), so an
  // empty stdout means "nothing injected", not "failed".
  let additionalContext = null;
  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout);
      additionalContext =
        (parsed &&
          parsed.hookSpecificOutput &&
          parsed.hookSpecificOutput.additionalContext) ||
        null;
    } catch {
      additionalContext = null;
    }
  }

  return {
    exitCode: code,
    stderr,
    raw: stdout,
    additionalContext,
    ...parseInjectedIndex(additionalContext),
  };
}

/**
 * Where a key landed in the injected set — the primitive PR4's retrieval metric
 * and PR5's position axis are both built on.
 *
 * `injected` (present, and where) is kept distinct from `absent` on purpose: a
 * failure with the lesson present is a UTILIZATION failure, while a failure with
 * it absent is a RETRIEVAL failure, and collapsing the two would make the
 * scale/position sweep unable to say which one it measured.
 */
export function positionOf(injection, key) {
  const hit = injection.lessons.find((l) => l.key === key);
  return hit
    ? { injected: true, position: hit.position, scope: hit.scope }
    : { injected: false, position: null, scope: null };
}
