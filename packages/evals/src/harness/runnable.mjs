// Can a LIVE run happen here at all, and if not, exactly what is missing?
//
// Every subcommand that spawns a model fails in the SAME way when its
// preconditions are absent — an empty transcript — and an empty transcript is
// reported downstream as a harness fault or a contaminated environment. So the
// three ways a live run cannot start are decided HERE, before anything spawns,
// and each is named. Two of the three were diagnosed the expensive way first:
//
//   • a model pin the CLI no longer serves (fixed by pinning the model in
//     `agent.mjs` and recording it per rep — not this module's job, but the
//     same failure signature, which is why it is worth stating here);
//   • `--permission-mode bypassPermissions` under root, which the CLI REFUSES.
//     It costs a whole session to find, because the refusal goes to a stderr
//     the runner used to discard and the visible symptom is a 0-byte
//     transcript. Containers run as root; a GitHub Actions runner does not.
//
// WHY THIS EXISTS AS A GATE AND NOT AS A COMMENT.
// It is what makes the harness safe to put in CI. A workflow that has no
// credential — a fork PR, or a repository before the secret is added — must
// SKIP cleanly rather than fail, or the job is red for a reason that has
// nothing to do with the change under review. That is the same discipline the
// `agent-skills` L2 workflow relies on.
//
// It is deliberately NOT the default locally. A developer who types
// `golden --reps 3` and gets exit 0 with no runs has been told nothing; they
// want the missing piece named. `--skip-if-unavailable` is how CI asks for the
// other behaviour, and asking is the point.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { DEFAULT_AGENT_COMMAND, DEFAULT_PERMISSION_MODE } from "./agent.mjs";

/**
 * The environment variables that can carry credentials for `claude -p`.
 *
 * Either is sufficient. Listed rather than hardcoded to one so a runner
 * authenticated by OAuth token is not reported as having no credential at all.
 */
export const CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

export const REASON_NO_BINARY = "agent-binary-missing";
export const REASON_NO_CREDENTIAL = "no-credential";
export const REASON_BYPASS_AS_ROOT = "bypass-permissions-as-root";

/**
 * Find an executable the way a shell would: an explicit path is checked as
 * given, a bare name is looked up across PATH. No subprocess — probing with
 * `--version` would spawn the very thing this function exists to decide about.
 */
export function resolveCommandPath(command, { env = process.env } = {}) {
  if (typeof command !== "string" || command === "") return null;
  const executable = (candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes(path.sep)) {
    return executable(path.resolve(command)) ? path.resolve(command) : null;
  }
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/**
 * Decide whether a live run can start, and name every missing precondition.
 *
 * Returns EVERY reason, not the first one. A CI log that says "no credential"
 * and then, after the secret is added, says "no binary" costs two round trips
 * to learn one thing.
 *
 * @param {object} [options]
 * @param {object} [options.env]             environment to read
 * @param {string} [options.command]         the agent binary (default "claude")
 * @param {string} [options.permissionMode]  what will be passed to the CLI
 * @param {number|null} [options.uid]        effective uid; null where unavailable
 * @param {Function} [options.resolve]       command resolver, injectable for tests
 */
export function assessRunnability({
  env = process.env,
  command = DEFAULT_AGENT_COMMAND,
  permissionMode = DEFAULT_PERMISSION_MODE,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  resolve = resolveCommandPath,
} = {}) {
  const reasons = [];

  const commandPath = resolve(command, { env });
  if (!commandPath) {
    reasons.push({
      kind: REASON_NO_BINARY,
      detail:
        `the agent binary "${command}" is not on PATH. Install it ` +
        `(npm i -g @anthropic-ai/claude-code) or pass --command <path>.`,
    });
  }

  const credential =
    CREDENTIAL_ENV_VARS.find(
      (name) => typeof env[name] === "string" && env[name].trim() !== "",
    ) || null;
  if (!credential) {
    reasons.push({
      kind: REASON_NO_CREDENTIAL,
      detail:
        `none of ${CREDENTIAL_ENV_VARS.join(" / ")} is set, so every attempt ` +
        `would produce an empty transcript and be reported as a harness fault.`,
    });
  }

  // The expensive-to-diagnose one. The CLI refuses `bypassPermissions` under
  // root and says so on a stderr that is easy to discard; what the harness sees
  // is a 0-byte transcript, which every downstream classifier reads as
  // something else entirely.
  if (uid === 0 && permissionMode === "bypassPermissions") {
    reasons.push({
      kind: REASON_BYPASS_AS_ROOT,
      detail:
        `running as root with --permission-mode bypassPermissions, which the ` +
        `CLI refuses; the run would produce an empty transcript. Pass ` +
        `--permission-mode acceptEdits, or run as a non-root user.`,
    });
  }

  return {
    runnable: reasons.length === 0,
    reasons,
    credential,
    commandPath,
    uid,
    permissionMode,
  };
}

/** One line naming what is missing, for a log or a CI step summary. */
export function describeRunnability(assessment) {
  if (!assessment || assessment.runnable) {
    return (
      `live runs are available` +
      (assessment && assessment.credential
        ? ` (credential: ${assessment.credential})`
        : "")
    );
  }
  return `live runs are unavailable: ${assessment.reasons
    .map((r) => r.detail)
    .join(" ")}`;
}
