#!/usr/bin/env node
// Live eval runner. THIS IS NOT A TEST.
//
// Every subcommand here spends real model tokens against `claude -p`, takes
// minutes, and is inherently flaky. It is therefore never invoked from
// `node --test` and never from CI — `pnpm nx test evals` covers the pure logic
// only, and the harness gates nothing until the signal is shown to be stable.
//
// The one exception is `probe`, which spawns no model at all: it seeds the
// store, installs the real hook and prints what the hook actually injected. It
// is here rather than in the test suite because it is a diagnostic you run
// against a store you are curious about, not an assertion.
//
// Subcommands (later PRs fill in the rest):
//   arm0    one attempt against an EMPTY store — the "no memory" baseline
//   probe   seed + install the hook + print the injected set (no model)
//   golden  arms 0/A/B/C x {organic,canonical}                        (PR4)
//   scale   corpus size x lesson position sweep                       (PR5)
//   review  pr-reviewer control vs treatment on PR #395               (PR6)
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  MODEL_UNDER_TEST,
  DEFAULT_TIMEOUT_MS,
  runAgent,
} from "../src/agent.mjs";
import {
  initGitIdentity,
  assertScopesAvailable,
  DEFAULT_OWNER_REPO,
  DEFAULT_BRANCH,
} from "../src/git-identity.mjs";
import {
  installSessionStartHook,
  readInjectedLessons,
} from "../src/hook-install.mjs";
import { writeMcpConfig } from "../src/mcp-config.mjs";
import { createSandbox } from "../src/sandbox.mjs";
import { empty, seedCanonical, seedOrganic } from "../src/store-setup.mjs";

// PR3 replaces this with the real golden task from `src/task.mjs`. Until then
// arm0 exercises the plumbing end to end with a prompt that is cheap and has an
// unambiguous outcome.
const PLACEHOLDER_PROMPT =
  "Reply with exactly the word READY and nothing else. Do not use any tools.";

const USAGE = `Usage: node bin/run-eval.mjs <subcommand> [options]

Subcommands:
  arm0                 One live attempt against an empty scratch store.
  probe                Seed the store, install the real SessionStart hook and
                       print what it injects. Spawns no model.

Options:
  --reps <n>           Repetitions (default 3; N=3 is a low-power INDICATOR).
  --out <dir>          Artifact directory (default ./.eval-out).
  --timeout <ms>       Hard wall-clock ceiling per attempt (default ${DEFAULT_TIMEOUT_MS}).
  --command <bin>      Agent binary (default "claude"; override for smoke tests).
  --seed <source>      probe: empty | canonical | organic (default canonical).
  --lesson <text>      probe: the arm-0 lesson text, required for --seed organic.
  --scope <scope>      probe: scope to seed at (default the branch scope).
  --keep               Leave each sandbox on disk for inspection.
  --dry-run            Build and print the plan without spawning the agent.
  -h, --help           Show this help.
`;

/** The two lesson sources the design calls for, plus the arm-A control. */
export const SEED_SOURCES = ["empty", "canonical", "organic"];

export function parseArgs(argv) {
  const [subcommand, ...rest] = argv;
  const options = {
    subcommand: subcommand || null,
    reps: 3,
    out: ".eval-out",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    command: "claude",
    seed: "canonical",
    lesson: null,
    scope: null,
    keep: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--reps":
        options.reps = Number(rest[++i]);
        break;
      case "--out":
        options.out = rest[++i];
        break;
      case "--timeout":
        options.timeoutMs = Number(rest[++i]);
        break;
      case "--command":
        options.command = rest[++i];
        break;
      case "--seed":
        options.seed = rest[++i];
        break;
      case "--lesson":
        options.lesson = rest[++i];
        break;
      case "--scope":
        options.scope = rest[++i];
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.reps) || options.reps < 1) {
    throw new Error(`--reps must be a positive integer, got ${options.reps}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(
      `--timeout must be a positive number of ms, got ${options.timeoutMs}`,
    );
  }
  if (!SEED_SOURCES.includes(options.seed)) {
    throw new Error(
      `--seed must be one of ${SEED_SOURCES.join(", ")}, got ${options.seed}`,
    );
  }
  if (options.seed === "organic" && !options.lesson) {
    throw new Error("--seed organic requires --lesson <text>");
  }
  return options;
}

/** `2026-08-08T21-06-56-253Z` — sortable and filesystem-safe. */
export function runId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function runArm0(options) {
  const id = runId();
  const outDir = path.resolve(options.out, `arm0-${id}`);
  await fsp.mkdir(outDir, { recursive: true });

  const reps = [];
  for (let rep = 1; rep <= options.reps; rep++) {
    // A FRESH sandbox per rep: no attempt may inherit another attempt's store,
    // working directory, or hook state.
    const sandbox = await createSandbox({ keep: options.keep });
    const repDir = path.join(outDir, `rep-${rep}`);
    await fsp.mkdir(repDir, { recursive: true });
    try {
      await sandbox.stripInformationEnvironment();
      const meta = {
        rep,
        arm: "0",
        model: MODEL_UNDER_TEST,
        store: "empty",
        cwd: sandbox.cwd,
        lorekitHome: sandbox.lorekitHome,
        startedAt: new Date().toISOString(),
      };

      if (options.dryRun) {
        reps.push({ ...meta, dryRun: true });
      } else {
        const run = await runAgent({
          prompt: PLACEHOLDER_PROMPT,
          cwd: sandbox.cwd,
          env: sandbox.childEnv(),
          transcriptPath: path.join(repDir, "transcript.jsonl"),
          command: options.command,
          timeoutMs: options.timeoutMs,
        });
        await fsp.writeFile(
          path.join(repDir, "result.json"),
          JSON.stringify(run.resultJson, null, 2),
        );
        if (run.stderr)
          await fsp.writeFile(path.join(repDir, "stderr.log"), run.stderr);
        reps.push({
          ...meta,
          ...run.summary,
          wallMs: run.wallMs,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          transcript: path.relative(outDir, run.transcriptPath),
        });
      }
      await fsp.writeFile(
        path.join(repDir, "meta.json"),
        JSON.stringify(reps[reps.length - 1], null, 2),
      );
    } finally {
      await sandbox.dispose();
    }
  }

  const summary = {
    subcommand: "arm0",
    runId: id,
    model: MODEL_UNDER_TEST,
    reps: options.reps,
    // Restated in every artifact on purpose: whoever reads a result file months
    // from now must see the caveat without going back to the README.
    caveat: `N=${options.reps} is a low-power INDICATOR, not proof. Treat differences as directional.`,
    results: reps,
  };
  await fsp.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  return { outDir, summary };
}

/**
 * Build one arm's world: git identity, information-environment strip, store
 * seeding, MCP config, and (for the memory arms) the real SessionStart hook.
 * Takes the sandbox and returns only what the assembly produced —
 * `{derived, targetScope, seeded, mcp, hookInstall}` — so a caller keeps using
 * the sandbox it passed in.
 *
 * PR4's `arms.mjs` orchestrates reps on top of this; keeping the assembly in
 * one place is what stops arm A and arm B from differing in anything except
 * the store, which is the whole experimental control.
 */
export async function prepareArm(
  sandbox,
  { seed = "canonical", lesson = null, scope = null, hook = true } = {},
) {
  const derived = await initGitIdentity(sandbox.cwd, {
    ownerRepo: DEFAULT_OWNER_REPO,
    branch: DEFAULT_BRANCH,
  });
  const targetScope = scope || derived.branchScope;
  assertScopesAvailable(derived, [targetScope]);

  // Strip AFTER git init: the repo has no content, but the order makes the
  // invariant obvious — nothing the agent can read may mention the gotcha.
  await sandbox.stripInformationEnvironment();

  let seeded = { seeded: [] };
  if (seed === "empty")
    seeded = await empty(sandbox, { scopes: derived.readOrder });
  else if (seed === "canonical")
    seeded = await seedCanonical(sandbox, { scope: targetScope });
  else if (seed === "organic")
    seeded = await seedOrganic(sandbox, { scope: targetScope, value: lesson });
  // Falling through would leave `seeded` empty and turn arm B into arm A — a
  // null result that measured nothing. Fail like `empty()` and
  // `assertScopesAvailable` do.
  else
    throw new Error(
      `seed must be one of ${SEED_SOURCES.join(", ")}, got ${seed}`,
    );

  const mcp = await writeMcpConfig(sandbox, { allowWrite: false });
  const hookInstall = hook ? installSessionStartHook(sandbox) : null;

  return { derived, targetScope, seeded, mcp, hookInstall };
}

async function runProbe(options) {
  const sandbox = await createSandbox({ keep: options.keep });
  try {
    const arm = await prepareArm(sandbox, {
      seed: options.seed,
      lesson: options.lesson,
      scope: options.scope,
    });
    const injection = await readInjectedLessons(sandbox);
    return {
      subcommand: "probe",
      seed: options.seed,
      scope: arm.targetScope,
      readOrder: arm.derived.readOrder,
      seeded: arm.seeded.seeded,
      mcpConfig: arm.mcp.config,
      allowedTools: arm.mcp.allowedTools,
      hookFile: arm.hookInstall.file,
      hookEvents: arm.hookInstall.events,
      injectedHeader: injection.header,
      injectedCount: injection.lessons.length,
      injected: injection.lessons,
    };
  } finally {
    await sandbox.dispose();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.subcommand) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.subcommand === "probe") {
    const result = await runProbe(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (options.subcommand !== "arm0") {
    process.stderr.write(
      `subcommand "${options.subcommand}" is not implemented yet\n\n${USAGE}`,
    );
    return 2;
  }
  const { outDir, summary } = await runArm0(options);
  process.stdout.write(
    `${JSON.stringify(summary, null, 2)}\n\nartifacts: ${outDir}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    },
  );
}
