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
 *   <root>/artifacts      transcripts / result JSON, copied out before dispose
 *
 * @returns {Promise<{
 *   root: string, cwd: string, lorekitHome: string, lorekitStore: string,
 *   artifacts: string, env: Record<string,string>,
 *   childEnv: (extra?: Record<string,string>) => Record<string,string>,
 *   stripInformationEnvironment: () => Promise<string[]>,
 *   findSpoilers: (
 *     terms?: string[],
 *     opts?: { dir?: string, skip?: Set<string> },
 *   ) => Promise<{ file: string, term: string }[]>,
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
     */
    async stripInformationEnvironment() {
      const removed = [];
      for (const rel of INFORMATION_ENVIRONMENT_FILES) {
        const target = path.join(cwd, rel);
        try {
          await fs.rm(target, { recursive: true, force: false });
          removed.push(rel);
        } catch {
          // absent is the expected case
        }
      }
      return removed;
    },

    /**
     * Scan the working directory for text that would let the agent solve the
     * task by reading rather than remembering, and return every hit.
     *
     * This is the assertion behind the information-environment control: the
     * ONLY thing that may differ between arm A and arm B is whether the store
     * is populated. A stray doc that spells out the gotcha would lift arm A to
     * arm B's score and the experiment would report "memory does not help"
     * while actually having measured nothing. Failing loudly is the point.
     *
     * `.git` is skipped — the sandbox's git identity is deliberate wiring
     * (see `git-identity.mjs`), not content the agent reads.
     */
    async findSpoilers(
      terms = [],
      { dir = cwd, skip = new Set([".git", "node_modules"]) } = {},
    ) {
      const hits = [];
      const needles = terms.map((t) => String(t).toLowerCase()).filter(Boolean);
      if (needles.length === 0) return hits;

      const walk = async (current) => {
        const entries = await fs
          .readdir(current, { withFileTypes: true })
          .catch(() => []);
        for (const entry of entries) {
          if (skip.has(entry.name)) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          const text = await fs.readFile(full, "utf8").catch(() => null);
          if (text == null) continue; // binary / unreadable
          const haystack = text.toLowerCase();
          for (const needle of needles) {
            if (haystack.includes(needle))
              hits.push({ file: path.relative(dir, full), term: needle });
          }
        }
      };
      await walk(dir);
      return hits;
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
