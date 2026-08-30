// Give the sandbox working directory a git identity.
//
// WHY this is load-bearing rather than cosmetic. `deriveScope`
// (`packages/cli/src/shared/scope.mjs`) reads `remote.origin.url` and the current
// branch to build the scopes the SessionStart hook reads from —
// `[project::<dir>, branch::<owner>/<repo>::<branch>, repo::<owner>/<repo>,
// global]`. A bare temp directory has no remote, so those scopes do not exist
// and a lesson seeded at `branch::mthines/gw-tools::feat/x` would never be
// injected. Arm B would then differ from arm A only in a store nobody reads,
// and the experiment would measure nothing while appearing to run correctly.
//
// So the sandbox is made to LOOK like the repository the golden task is about.
// The scopes are then VERIFIED by calling the real `deriveScope` — never
// assembled by hand here, because a second implementation of the scope rules is
// exactly the drift this harness cannot afford.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { deriveScope } from "@lorekit/cli/src/shared/scope.mjs";

const exec = promisify(execFile);

/** The repository and branch the golden task is set in. */
export const DEFAULT_OWNER_REPO = "mthines/gw-tools";
export const DEFAULT_BRANCH = "feat/x";

async function git(args, cwd) {
  return exec("git", args, {
    cwd,
    env: {
      ...process.env,
      // A developer's global git config must not change what the sandbox looks
      // like from one machine to the next.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

/**
 * Initialise `cwd` as a git repository whose origin and branch make the target
 * scopes real. Nothing is ever pushed — `deriveScope` needs only the remote URL
 * and a resolvable branch.
 *
 * The empty commit is NOT optional. `deriveScope` reads the branch with
 * `git rev-parse --abbrev-ref HEAD`, which FAILS on a repository whose initial
 * branch is still unborn, so a freshly `init`ed directory yields
 * `branch: null` → no `branch::` scope → the golden task's lesson is seeded
 * into a scope the hook never reads. That failure is silent (`deriveScope`
 * swallows the git error and returns null), which is exactly why the caller
 * should follow this with `assertScopesAvailable`.
 *
 * @returns the resolved scope object from the REAL `deriveScope`.
 */
export async function initGitIdentity(
  cwd,
  { ownerRepo = DEFAULT_OWNER_REPO, branch = DEFAULT_BRANCH } = {},
) {
  await git(["init", "--quiet", "--initial-branch", branch], cwd);
  await git(
    ["remote", "add", "origin", `https://github.com/${ownerRepo}.git`],
    cwd,
  );
  // Identity is supplied per-command because the global config is disabled
  // above; it is never read by anything and never leaves the sandbox.
  await git(
    [
      "-c",
      "user.name=LoreKit Evals",
      "-c",
      "user.email=evals@lorekit.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "init",
    ],
    cwd,
  );
  return deriveScope(cwd);
}

/**
 * Assert the sandbox really derives the scopes an arm depends on. Called before
 * a run rather than after: an arm that quietly reads the wrong scopes produces
 * numbers that look fine and mean nothing, so this fails loudly up front.
 */
export function assertScopesAvailable(scope, expected = []) {
  const missing = expected.filter((s) => !scope.readOrder.includes(s));
  if (missing.length > 0) {
    throw new Error(
      `sandbox does not derive the required scope(s) ${missing.join(", ")}; ` +
        `readOrder is [${scope.readOrder.join(", ")}]`,
    );
  }
  return scope;
}
