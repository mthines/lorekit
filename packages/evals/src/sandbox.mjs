// Per-run isolation for the eval harness.
//
// Every rep of every arm gets a throwaway world: a fresh working directory the
// agent under test runs in, and a scratch LoreKit store the CLI/MCP/hook read
// and write through. Nothing the harness does may reach `~/.lorekit` — an eval
// that pollutes the operator's real memory is worse than no eval, because the
// damage is silent and only shows up as a poisoned lesson weeks later.
//
// Isolation is achieved the same way production resolves its store, not by
// monkey-patching: `packages/cli/src/control.mjs` roots the home tier at
// `$LOREKIT_HOME` (default `~/.lorekit`) and the project tier at
// `$LOREKIT_STORE`, and `LOREKIT_MODE=local` forces the offline file store. Point
// all three at a `mkdtemp` directory and the real store is unreachable by
// construction — there is no code path from the sandbox env to the real home.
//
// The guard below is belt-and-braces on top of that: if a caller ever hands in a
// home that resolves to the real one, we throw rather than run.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The real per-user store this harness must never touch. */
export const REAL_LOREKIT_HOME = path.join(os.homedir(), ".lorekit");

/**
 * Files that would let the agent solve the task by reading the repo instead of
 * by remembering. The golden task's whole premise is that the gotcha is NOT
 * documented in the working directory, so the only difference between arm A
 * (empty store) and arm B (seeded store) is memory. PR2 asserts the sandbox is
 * clean of these; PR1 provides the seam.
 */
export const INFORMATION_ENVIRONMENT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  path.join(".github", "copilot-instructions.md"),
  path.join(".claude", "CLAUDE.md"),
];

/**
 * True when `candidate` is the real store root or lives inside it. Compares
 * resolved paths with a separator-terminated prefix so `~/.lorekit-eval` is not
 * mistaken for a child of `~/.lorekit`.
 */
export function isInsideRealHome(candidate, realHome = REAL_LOREKIT_HOME) {
  const a = path.resolve(candidate);
  const b = path.resolve(realHome);
  return a === b || a.startsWith(b + path.sep);
}

/**
 * Create an isolated world for one eval rep.
 *
 * Layout under a single `mkdtemp` root so teardown is one `rm -rf`:
 *   <root>/cwd            working directory handed to the agent
 *   <root>/lorekit-home   scratch $LOREKIT_HOME (home tier + config.json)
 *   <root>/lorekit-store  scratch $LOREKIT_STORE (project tier)
 *   <root>/artifacts      scratch space for anything a rep needs to write
 *                        INSIDE the sandbox
 *
 * `artifacts` is a seam, not the artifact destination. Durable output —
 * transcripts, `result.json`, `meta.json` — is written straight to the run's
 * `--out` directory by `bin/run-eval.mjs`, which lives OUTSIDE the sandbox and
 * therefore survives `dispose()` with nothing to copy out. Anything left under
 * `<root>/artifacts` is destroyed by teardown unless `keep` is set.
 *
 * @returns {Promise<{
 *   root: string, cwd: string, lorekitHome: string, lorekitStore: string,
 *   artifacts: string, env: Record<string,string>,
 *   childEnv: (extra?: Record<string,string>) => Record<string,string>,
 *   stripInformationEnvironment: () => Promise<string[]>,
 *   disposed: () => boolean, dispose: () => Promise<void>,
 * }>}
 */
export async function createSandbox({
  prefix = "lorekit-eval-",
  keep = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const cwd = path.join(root, "cwd");
  const lorekitHome = path.join(root, "lorekit-home");
  const lorekitStore = path.join(root, "lorekit-store");
  const artifacts = path.join(root, "artifacts");

  if (isInsideRealHome(lorekitHome)) {
    // Unreachable in practice (os.tmpdir() is not under ~/.lorekit), but this is
    // the one invariant worth crashing on rather than trusting.
    await fs.rm(root, { recursive: true, force: true });
    throw new Error(
      `refusing to run: scratch LOREKIT_HOME resolved inside ${REAL_LOREKIT_HOME}`,
    );
  }

  for (const dir of [cwd, lorekitHome, lorekitStore, artifacts]) {
    await fs.mkdir(dir, { recursive: true });
  }

  // The env every child process (claude, lorekit CLI, the MCP stdio server, the
  // SessionStart hook) inherits. `LOREKIT_MODE=local` keeps the run offline so a
  // rep can never write to the hosted store, and telemetry is opted out so eval
  // traffic does not pollute real usage data.
  const env = Object.freeze({
    LOREKIT_HOME: lorekitHome,
    LOREKIT_STORE: lorekitStore,
    LOREKIT_MODE: "local",
    LOREKIT_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  });

  let isDisposed = false;

  return {
    root,
    cwd,
    lorekitHome,
    lorekitStore,
    artifacts,
    env,

    /** `process.env` + the sandbox overrides, for spawning a child. */
    childEnv(extra = {}) {
      return { ...process.env, ...env, ...extra };
    },

    /**
     * Remove any agent-instruction file from the sandbox cwd so the working
     * directory cannot spoil the gotcha. Returns the paths actually removed.
     *
     * ONLY `ENOENT` is swallowed. A delete that fails for any other reason —
     * `EACCES`/`EPERM`, or a busy path — left the file in place while this
     * function reported it as absent, which reads as "the sandbox is clean" and
     * silently weakens the isolation invariant the arms depend on. Failing
     * loudly is the correct outcome: the caller runs this inside `try`/`finally`
     * with `dispose()`, so the sandbox is still torn down.
     */
    async stripInformationEnvironment() {
      const removed = [];
      for (const rel of INFORMATION_ENVIRONMENT_FILES) {
        const target = path.join(cwd, rel);
        try {
          await fs.rm(target, { recursive: true, force: false });
          removed.push(rel);
        } catch (err) {
          // Absent is the expected case; anything else means the file may still
          // be there and the caller must not be told the cwd is clean.
          if (err && err.code === "ENOENT") continue;
          throw err;
        }
      }
      return removed;
    },

    disposed() {
      return isDisposed;
    },

    /** Idempotent teardown. `keep` leaves the tree on disk for inspection. */
    async dispose() {
      if (isDisposed) return;
      isDisposed = true;
      if (keep) return;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Run `fn` with a sandbox and always tear it down, even when `fn` throws — the
 * smoke-cleanup discipline the rest of the repo follows, expressed as a scope.
 */
export async function withSandbox(options, fn) {
  const sandbox = await createSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
