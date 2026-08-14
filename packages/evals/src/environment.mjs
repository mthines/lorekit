// Was the agent's information environment actually clean?
//
// THE FAILURE THIS EXISTS TO PREVENT.
// The first live run of this harness surfaced it: on a real developer machine,
// `claude -p` loaded ~130 globally-installed skills, 5 plugins, 35 MCP servers
// and five `SessionStart` hooks — 101k tokens of preamble, at $1.13 for a
// one-word prompt. Among those skills was `lorekit-memory`, whose SKILL.md
// says, verbatim:
//
//     branch::{owner}/{repo}::{branch}       short-lived, this branch only
//
// That is the golden task's answer, in the context window, before a single
// memory is read. Arm A would have scored 100 with an empty store, arm B could
// show no lift, and the experiment would have reported "memory does not help"
// having measured nothing at all.
//
// `sandbox.findSpoilers` cannot catch this: it scans the sandbox working
// directory, and the leak is in `~/.claude/skills`. The information-environment
// control (AC-2.4) was checking the wrong surface.
//
// WHY THIS IS A CHECK AND NOT JUST FLAGS.
// `--disable-slash-commands`, `--strict-mcp-config` and a plugin-disabling
// `--settings` express INTENT. Whether a given `claude` version honours them —
// and whether a user-level hook fires anyway — is not something the harness can
// know. The init event and the `hook_started` events report what really loaded,
// so the harness judges the outcome and refuses to score a contaminated rep.
// A rep that ran dirty is not a data point; it is a discarded run.

import { MCP_SERVER_NAME } from "./mcp-config.mjs";

/**
 * MCP servers an arm is allowed to see. Anything else is contamination.
 *
 * Derived from `MCP_SERVER_NAME` rather than spelled again: that constant is
 * the key the harness writes into `.mcp.json`, so renaming the server there
 * would otherwise make every rep read as contaminated by its own store.
 */
export const EXPECTED_MCP_SERVERS = [MCP_SERVER_NAME];

/** Hook events an arm expects to fire. Only the harness's own SessionStart. */
export const EXPECTED_HOOK_EVENT = "SessionStart";

export const FINDING_SKILLS = "skills-loaded";
export const FINDING_PLUGINS = "plugins-loaded";
export const FINDING_MCP_SERVERS = "unexpected-mcp-servers";
export const FINDING_SLASH_COMMANDS = "slash-commands-loaded";
export const FINDING_FOREIGN_HOOKS = "foreign-hooks-fired";
export const FINDING_MISSING_HOOKS = "expected-hooks-missing";
export const FINDING_CWD = "ran-outside-the-sandbox";
export const FINDING_NO_INIT = "no-init-event";

/**
 * Flatten the init event and hook stream into the few facts that matter.
 * Total: a missing or partial init event yields empty lists, never a throw.
 */
export function summarizeEnvironment({ init = null, hookEvents = [] } = {}) {
  const servers = Array.isArray(init && init.mcp_servers)
    ? init.mcp_servers
    : [];
  return {
    present: Boolean(init),
    cwd: (init && init.cwd) || null,
    model: (init && init.model) || null,
    permissionMode: (init && init.permissionMode) || null,
    skills: Array.isArray(init && init.skills) ? init.skills : [],
    plugins: (Array.isArray(init && init.plugins) ? init.plugins : []).map(
      (p) => (p && p.name) || String(p),
    ),
    slashCommands: Array.isArray(init && init.slash_commands)
      ? init.slash_commands
      : [],
    mcpServers: servers.map((s) => (s && s.name) || String(s)),
    toolCount: Array.isArray(init && init.tools) ? init.tools.length : 0,
    hooks: (hookEvents || []).map((h) => h.name || "(unnamed)"),
  };
}

/**
 * Judge an environment. Returns findings rather than throwing, so a caller can
 * record the contamination on the rep and carry on rather than losing the run.
 *
 * @param {object} summary            from `summarizeEnvironment`
 * @param {object} [options]
 * @param {string} [options.sandboxRoot]      the run's sandbox, to verify cwd
 * @param {string[]} [options.expectedMcpServers]
 * @param {number} [options.expectedHooks]    how many hooks should have fired,
 *                                            exactly — more is a foreign hook,
 *                                            fewer means ours never fired
 */
export function assertCleanEnvironment(
  summary,
  {
    sandboxRoot = null,
    expectedMcpServers = EXPECTED_MCP_SERVERS,
    expectedHooks = 1,
  } = {},
) {
  const findings = [];

  if (!summary || !summary.present) {
    // No init event at all: the run may have died before starting. Treat it as
    // unverifiable rather than clean — "we could not check" must never read as
    // "it was fine".
    findings.push({
      kind: FINDING_NO_INIT,
      detail:
        "no init event in the transcript; the environment is unverifiable",
    });
    return { clean: false, verifiable: false, findings, summary };
  }

  if (summary.skills.length > 0) {
    findings.push({
      kind: FINDING_SKILLS,
      detail: `${summary.skills.length} skill(s) loaded: ${summary.skills.slice(0, 5).join(", ")}${summary.skills.length > 5 ? ", …" : ""}`,
      values: summary.skills,
    });
  }

  if (summary.plugins.length > 0) {
    findings.push({
      kind: FINDING_PLUGINS,
      detail: `${summary.plugins.length} plugin(s) loaded: ${summary.plugins.join(", ")}`,
      values: summary.plugins,
    });
  }

  const unexpected = summary.mcpServers.filter(
    (name) => !expectedMcpServers.includes(name),
  );
  if (unexpected.length > 0) {
    findings.push({
      kind: FINDING_MCP_SERVERS,
      detail: `${unexpected.length} unexpected MCP server(s): ${unexpected.slice(0, 5).join(", ")}${unexpected.length > 5 ? ", …" : ""}`,
      values: unexpected,
    });
  }

  if (summary.slashCommands.length > 0) {
    findings.push({
      kind: FINDING_SLASH_COMMANDS,
      detail: `${summary.slashCommands.length} slash command(s) available`,
      values: summary.slashCommands.slice(0, 10),
    });
  }

  // Both directions are contamination, and they are opposite failures, so they
  // get their own kinds. TOO MANY hooks means the developer's user settings
  // fired alongside ours. TOO FEW means the harness's own SessionStart never
  // fired — no lesson was injected, arm B silently ran as arm A, and the rep
  // would otherwise have been scored as a clean measurement of memory's value.
  // That is the exact failure the settings override omits `hooks: {}` to avoid,
  // and omitting the flag only prevents one cause of it, not the outcome.
  if (summary.hooks.length > expectedHooks) {
    findings.push({
      kind: FINDING_FOREIGN_HOOKS,
      detail: `${summary.hooks.length} hooks fired, expected ${expectedHooks}: ${summary.hooks.join(", ")}`,
      values: summary.hooks,
    });
  } else if (summary.hooks.length < expectedHooks) {
    findings.push({
      kind: FINDING_MISSING_HOOKS,
      detail: `${summary.hooks.length} hooks fired, expected ${expectedHooks}: the harness's own hook did not fire${summary.hooks.length > 0 ? `; saw ${summary.hooks.join(", ")}` : ""}`,
      values: summary.hooks,
    });
  }

  if (sandboxRoot && summary.cwd && !summary.cwd.startsWith(sandboxRoot)) {
    findings.push({
      kind: FINDING_CWD,
      detail: `ran in ${summary.cwd}, which is outside the sandbox ${sandboxRoot}`,
    });
  }

  return { clean: findings.length === 0, verifiable: true, findings, summary };
}

/**
 * A one-line verdict for a run artifact or a console line.
 */
export function describeEnvironment(verdict) {
  if (!verdict) return "environment: unknown";
  if (!verdict.verifiable) return "environment: UNVERIFIABLE (no init event)";
  if (verdict.clean) {
    return `environment: clean (${verdict.summary.toolCount} tools, ${verdict.summary.mcpServers.length} mcp server(s), ${verdict.summary.hooks.length} hook(s))`;
  }
  return `environment: CONTAMINATED — ${verdict.findings.map((f) => f.kind).join(", ")}`;
}
