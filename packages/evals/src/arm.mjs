// Assemble one arm's world.
//
// Everything an arm needs — git identity (or deliberately none), the
// information-environment strip, the store seeding, the MCP config and the
// SessionStart hook — is built HERE, in one place, so arm A and arm B cannot
// come to differ in anything except the store. That is the whole experimental
// control, and it is far too easy to break by hand at each call site.
//
// WHY THE SCOPE IS A PARAMETER AND GIT IS OPTIONAL.
// A LoreKit scope is chosen explicitly by whoever writes the memory —
// `memory.write` requires `scope`, and no write path anywhere in the CLI
// derives it. Git decides only which scopes are DISCOVERED for a directory:
// `deriveScope` turns the remote and branch into the `readOrder` the
// SessionStart hook reads from. So a lesson can be written to
// `branch::owner/repo::x` in a directory with no git at all — it just will not
// be injected there.
//
// That distinction is not a detail; it is the difference between two failures
// the experiment must never confuse:
//   • the lesson was never injected  → a RETRIEVAL failure;
//   • the lesson was injected and the agent still got it wrong → a UTILIZATION
//     failure.
// Holding the scope fixed at the git-derived branch scope would leave the
// harness unable to tell those apart, and a null result would be unreadable.
// So the scope is a first-class knob, and a `global`-scoped arm (which injects
// in ANY directory, git or not) is available as the control that isolates
// scope resolution from memory utility.
import { deriveScope } from "@lorekit/cli/src/scope.mjs";

import {
  DEFAULT_BRANCH,
  DEFAULT_OWNER_REPO,
  assertScopesAvailable,
  initGitIdentity,
} from "./git-identity.mjs";
import { installSessionStartHook } from "./hook-install.mjs";
import { writeMcpConfig } from "./mcp-config.mjs";
import { empty, seedCanonical, seedOrganic } from "./store-setup.mjs";

/** Which of the derived scopes an arm seeds and expects to be injected. */
export const SCOPE_MODES = ["branch", "repo", "project", "global"];

/**
 * The scope modes that only EXIST when the working directory has a git remote.
 * `project::` is derived from the directory basename and `global` is constant,
 * so both survive a directory with no repository.
 */
export const GIT_DEPENDENT_SCOPE_MODES = ["branch", "repo"];

/** The lesson sources: the arm-A control plus the two arm-B variants. */
export const SEED_SOURCES = ["empty", "canonical", "organic"];

/** Resolve a scope mode against a `deriveScope` result. Null when unavailable. */
export function scopeForMode(derived, mode) {
  switch (mode) {
    case "branch":
      return derived.branchScope;
    case "repo":
      return derived.repoScope;
    case "project":
      return derived.projectScope;
    case "global":
      return "global";
    default:
      throw new TypeError(
        `unknown scope mode "${mode}"; expected one of ${SCOPE_MODES.join(", ")}`,
      );
  }
}

/** Does this scope mode need the sandbox to look like a git repository? */
export function requiresGit(mode) {
  return GIT_DEPENDENT_SCOPE_MODES.includes(mode);
}

/**
 * The same question as `requiresGit`, asked of an EXPLICIT scope string.
 *
 * An explicit `scope` overrides `scopeMode` outright, so the git default has to
 * be read off the scope that will actually be used — reading it off the ignored
 * mode is how `prepareArm(sandbox, { scope: "global" })` ended up initialising
 * git for a scope that never needed it.
 */
export function requiresGitForScope(scope) {
  const canonical = String(scope).toLowerCase();
  return GIT_DEPENDENT_SCOPE_MODES.some((mode) =>
    canonical.startsWith(`${mode}::`),
  );
}

/**
 * The scope a person would TYPE for this mode, whether or not the directory
 * can discover it.
 *
 * This is the concrete expression of "the scope is chosen, not derived": in a
 * directory with no git remote, `deriveScope` yields no `branch::` scope, but
 * `branch::mthines/gw-tools::feat/x` is still a perfectly writable scope and an
 * agent asked to use it will. Falling back to the nominal form is what lets the
 * harness seed exactly that situation on purpose and observe that the lesson
 * never reaches the context.
 *
 * Lowercased to match the canonical form the validator normalizes to.
 */
export function nominalScopeForMode(mode, { ownerRepo, branch, cwd } = {}) {
  switch (mode) {
    case "branch":
      return `branch::${ownerRepo}::${branch}`.toLowerCase();
    case "repo":
      return `repo::${ownerRepo}`.toLowerCase();
    case "project":
      return `project::${String(cwd || "")
        .split(/[\\/]/)
        .pop()}`.toLowerCase();
    case "global":
      return "global";
    default:
      throw new TypeError(
        `unknown scope mode "${mode}"; expected one of ${SCOPE_MODES.join(", ")}`,
      );
  }
}

/**
 * Build an arm.
 *
 * @param {object} sandbox            from `createSandbox`
 * @param {object} [options]
 * @param {string} [options.seed]       empty | canonical | organic
 * @param {string} [options.lesson]     arm-0 text, required for `organic`
 * @param {string} [options.scopeMode]  branch | repo | project | global
 * @param {string} [options.scope]      an explicit scope; overrides scopeMode
 * @param {boolean} [options.git]       force git identity on/off (default: on
 *                                      iff the scope actually used — the
 *                                      explicit `scope` when given, otherwise
 *                                      `scopeMode` — needs it)
 * @param {boolean} [options.hook]      install the SessionStart hook
 */
export async function prepareArm(
  sandbox,
  {
    seed = "canonical",
    lesson = null,
    scopeMode = "branch",
    scope = null,
    git = null,
    ownerRepo = DEFAULT_OWNER_REPO,
    branch = DEFAULT_BRANCH,
    hook = true,
  } = {},
) {
  if (!SEED_SOURCES.includes(seed)) {
    throw new TypeError(
      `unknown seed source "${seed}"; expected one of ${SEED_SOURCES.join(", ")}`,
    );
  }
  // Validated even when an explicit `scope` makes it unused: `parseArgs`
  // rejects an unknown `--scope-mode`, and silently accepting one here only
  // because a scope happened to be passed too would let a typo through on the
  // one path where nothing else is watching.
  if (!SCOPE_MODES.includes(scopeMode)) {
    throw new TypeError(
      `unknown scope mode "${scopeMode}"; expected one of ${SCOPE_MODES.join(", ")}`,
    );
  }

  // Default, not a requirement: git is initialised only when the requested
  // scope needs it to exist. An explicit `scope` overrides `scopeMode`, so the
  // default is derived from the scope that will actually be used — otherwise
  // the arm reports `scopeMode: "explicit"` while its git default still comes
  // from the mode it ignored. `git: false` with a branch scope is a legal,
  // deliberately-broken arm — it is how the harness reproduces a retrieval
  // failure on purpose — so it is allowed through to the assertion below.
  const wantGit =
    git === null
      ? scope
        ? requiresGitForScope(scope)
        : requiresGit(scopeMode)
      : Boolean(git);

  const derived = wantGit
    ? await initGitIdentity(sandbox.cwd, { ownerRepo, branch })
    : deriveScope(sandbox.cwd);

  // Discovered form first; the nominal form when the directory cannot discover
  // it. The nominal fallback is not a workaround — it is the case the harness
  // must be able to construct, because a person or an agent can write that
  // scope from that directory too.
  //
  // An explicit scope is lowercased for the same reason `nominalScopeForMode`
  // is: that is the canonical form the validator normalizes to and the form
  // `readOrder` carries, so a mixed-case value would otherwise seed one string
  // and compare against another — reporting `injectable: false` for a scope
  // the hook can see perfectly well.
  const targetScope =
    (scope && String(scope).toLowerCase()) ||
    scopeForMode(derived, scopeMode) ||
    nominalScopeForMode(scopeMode, { ownerRepo, branch, cwd: sandbox.cwd });

  // Whether the hook can see the seeded scope AT ALL. Recorded rather than
  // enforced: an arm that deliberately seeds an unreachable scope is a valid
  // experiment (it isolates retrieval), and callers assert on this field.
  const injectable = derived.readOrder.includes(targetScope);

  // Strip AFTER git init: the repo has no content, but the order makes the
  // invariant obvious — nothing the agent can read may mention the gotcha.
  await sandbox.stripInformationEnvironment();

  const auditScopes = [...new Set([...derived.readOrder, targetScope])];
  let seeded = { seeded: [] };
  if (seed === "empty") seeded = await empty(sandbox, { scopes: auditScopes });
  else if (seed === "canonical")
    seeded = await seedCanonical(sandbox, { scope: targetScope });
  else if (seed === "organic")
    seeded = await seedOrganic(sandbox, { scope: targetScope, value: lesson });

  const mcp = await writeMcpConfig(sandbox, { allowWrite: false });
  const hookInstall = hook ? installSessionStartHook(sandbox) : null;

  return {
    derived,
    scopeMode: scope ? "explicit" : scopeMode,
    targetScope,
    gitInitialized: wantGit,
    injectable,
    seeded,
    mcp,
    hookInstall,
  };
}

/**
 * Assert an arm is wired the way the experiment intends, BEFORE it runs.
 * Separate from `prepareArm` because "seed a scope the hook cannot see" is a
 * legitimate arm; only the caller knows which case it is in.
 */
export function assertArmInjectable(arm) {
  if (!arm.injectable) {
    assertScopesAvailable(arm.derived, [arm.targetScope]);
  }
  return arm;
}
