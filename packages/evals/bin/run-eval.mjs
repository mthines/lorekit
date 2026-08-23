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
} from "../src/harness/agent.mjs";
import { SCOPE_MODES, SEED_SOURCES, prepareArm } from "../src/harness/arm.mjs";
import {
  assertCleanEnvironment,
  describeEnvironment,
  summarizeEnvironment,
} from "../src/grading/environment.mjs";
import { gradeSandbox } from "../src/grading/grade.mjs";
import { readInjectedLessons } from "../src/sandbox/hook-install.mjs";
import { classifyRetrieval } from "../src/grading/retrieval.mjs";
import { createSandbox } from "../src/sandbox/sandbox.mjs";
import { listAll } from "../src/sandbox/store-setup.mjs";
import { taskById } from "../src/harness/task.mjs";

const USAGE = `Usage: node bin/run-eval.mjs <subcommand> [options]

Subcommands:
  arm0                 The golden task against an empty store, then graded.
  preflight            One throwaway model call in a prepared sandbox, then
                       report what the session actually loaded. Exits non-zero
                       when the environment is contaminated. It is a single
                       call in a fixed empty-store arm and writes no run
                       directory, and the model call IS the check, so it
                       REFUSES --seed, --lesson, --scope, --scope-mode,
                       --git/--no-git, --reps, --out and --dry-run rather than
                       ignoring them.
  probe                Seed the store, install the real SessionStart hook and
                       print what it injects. Spawns no model, so it REFUSES
                       --reps, --out, --timeout, --command and --dry-run rather
                       than ignoring them.

Options:
  --reps <n>           Repetitions (default 3; N=3 is a low-power INDICATOR).
  --out <dir>          Artifact directory (default ./.eval-out).
  --timeout <ms>       Hard wall-clock ceiling per attempt (default ${DEFAULT_TIMEOUT_MS}).
  --command <bin>      Agent binary (default "claude"; override for smoke tests).
  --seed <source>      probe: empty | canonical | organic (default canonical).
                       arm0 always runs against an EMPTY store and REFUSES this
                       flag rather than ignoring it.
  --lesson <text>      probe: the arm-0 lesson text, required for --seed organic.
                       Refused by arm0, as --seed is.
  --scope <scope>      an explicit scope to seed at (overrides the mode).
  --scope-mode <m>     branch | repo | project | global (default branch).
  --git / --no-git     force the sandbox git identity on/off. Default is on
                       only for the scope modes that need it (branch, repo);
                       --no-git with a branch scope reproduces a RETRIEVAL
                       failure on purpose.
                       These three apply to arm0 as well as probe. arm0 always
                       grades against the golden task's FIXED target scope, so
                       an override that resolves elsewhere could only ever
                       score a failure; arm0 refuses that combination up front
                       rather than reporting it as a model result.
  --keep               Leave each sandbox on disk for inspection.
  --dry-run            Build and print the plan without spawning the agent.
  -h, --help           Show this help.
`;

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
    scopeMode: "branch",
    git: null,
    keep: false,
    dryRun: false,
    help: false,
    // Which flags the caller actually TYPED. Several options have meaningful
    // defaults, so a subcommand that cannot honour one has no other way to tell
    // "left at the default" apart from "asked for, and about to be ignored".
    provided: new Set(),
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    options.provided.add(arg);
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
      case "--scope-mode":
        options.scopeMode = rest[++i];
        break;
      case "--no-git":
        options.git = false;
        break;
      case "--git":
        options.git = true;
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
  if (!SCOPE_MODES.includes(options.scopeMode)) {
    throw new Error(
      `--scope-mode must be one of ${SCOPE_MODES.join(", ")}, got ${options.scopeMode}`,
    );
  }
  return options;
}

/** `2026-08-08T21-06-56-253Z` — sortable and filesystem-safe. */
export function runId(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Refuse flags a subcommand would silently ignore.
 *
 * Pure ARGUMENT validation, meant to be hoisted above every sandbox: refusing
 * here costs nothing, where refusing inside the loop would first git-initialise,
 * strip and MCP-configure a sandbox only to throw it away. Silently ignoring is
 * the failure worth preventing — a caller who typed `--scope-mode repo` and got
 * a `branch::` run reads the result as a finding about the model.
 *
 * @param {object} options    from `parseArgs`
 * @param {string[]} flags    the flags this subcommand cannot honour
 * @param {string} because    why, phrased to complete "…, so <flags> cannot be
 *                            honoured here."
 * @param {string} [hint]     what to do instead, appended to the refusal
 */
function refuseUnhonourableFlags(options, flags, because, hint = "") {
  const ignored = flags.filter((f) => options.provided.has(f));
  if (ignored.length === 0) return;
  throw new Error(
    `${because}, so ${ignored.join(" and ")} cannot be honoured here. ` +
      `Drop ${ignored.length > 1 ? "them" : "it"}${hint ? `, ${hint}` : ""}.`,
  );
}

async function runArm0(options) {
  // Arm 0 is the empty-store arm by definition — its job is to produce the
  // organic lesson the seeded arms are later given — so it cannot honour a seed.
  refuseUnhonourableFlags(
    options,
    ["--seed", "--lesson"],
    "arm0 always runs against an EMPTY store",
    'or use the "probe" subcommand, which seeds',
  );

  const id = runId();
  const outDir = path.resolve(options.out, `arm0-${id}`);

  const reps = [];
  for (let rep = 1; rep <= options.reps; rep++) {
    // A FRESH sandbox per rep: no attempt may inherit another attempt's store,
    // working directory, or hook state.
    const sandbox = await createSandbox({ keep: options.keep });
    const repDir = path.join(outDir, `rep-${rep}`);
    try {
      // Arm 0 is the ONLY arm allowed to write memory: its whole job is to
      // produce the organic lesson arm B will later be seeded with.
      const arm = await prepareArm(sandbox, {
        seed: "empty",
        scopeMode: options.scopeMode,
        scope: options.scope,
        git: options.git,
        allowWrite: true,
      });
      const task = taskById("branch-scope");
      // NOT hoistable, unlike the seed check above: this one reads the scope
      // the arm actually RESOLVED to, which only exists after `prepareArm`. It
      // fires on rep 1, so at most one sandbox is ever built for nothing.
      //
      // `--scope` / `--scope-mode` / `--no-git` steer where the arm resolves,
      // but `gradeSandbox` below always grades against the task's fixed target.
      // A mismatch cannot produce anything but a 0-or-partial score, and it
      // would read as the model failing the task. Refuse it, the same way
      // `taskById` refuses a stub rather than running an empty eval.
      if (arm.targetScope !== task.targetScope) {
        throw new Error(
          `arm0 grades against the fixed target ${task.targetScope}, but the ` +
            `scope options resolved to ${arm.targetScope}; a run with this ` +
            `combination could only score a failure. Drop the scope override, ` +
            `or use the "probe" subcommand, which is not graded.`,
        );
      }
      // Create the artifact tree only now that the scope guard has passed, so a
      // refused invocation leaves no empty arm0-<id>/rep-N/ behind — matching the
      // seed refusal hoisted above the loop. `recursive` creates outDir too.
      await fsp.mkdir(repDir, { recursive: true });
      const meta = {
        rep,
        arm: "0",
        task: task.id,
        model: MODEL_UNDER_TEST,
        store: "empty",
        targetScope: task.targetScope,
        scopeMode: arm.scopeMode,
        cwd: sandbox.cwd,
        lorekitHome: sandbox.lorekitHome,
        startedAt: new Date().toISOString(),
      };

      if (options.dryRun) {
        reps.push({ ...meta, dryRun: true });
      } else {
        const run = await runAgent({
          prompt: task.prompt(),
          cwd: sandbox.cwd,
          env: sandbox.childEnv(),
          transcriptPath: path.join(repDir, "transcript.jsonl"),
          command: options.command,
          timeoutMs: options.timeoutMs,
          ...arm.agentOptions,
        });
        // What the session really loaded. A rep that ran with the developer's
        // skills or plugins in context is not a data point — the lorekit-memory
        // skill alone states the golden task's answer — so the verdict is
        // recorded on the rep and the summary counts it as discarded.
        const environment = assertCleanEnvironment(summarizeEnvironment(run), {
          sandboxRoot: sandbox.root,
          expectedHooks: arm.hookInstall ? 1 : 0,
        });
        // Grade BEFORE the sandbox is torn down — the store is the evidence.
        const graded = await gradeSandbox(sandbox, {
          transcriptText: run.transcriptText,
          target: task.targetScope,
        });
        await fsp.writeFile(
          path.join(repDir, "result.json"),
          JSON.stringify(run.resultJson, null, 2),
        );
        await fsp.writeFile(
          path.join(repDir, "grade.json"),
          JSON.stringify(graded, null, 2),
        );
        await fsp.writeFile(
          path.join(repDir, "environment.json"),
          JSON.stringify(environment, null, 2),
        );
        if (run.stderr)
          await fsp.writeFile(path.join(repDir, "stderr.log"), run.stderr);
        reps.push({
          ...meta,
          ...run.summary,
          success: graded.success,
          score: graded.score,
          repeatedMistake: graded.repeatedMistake,
          storedScopes: graded.storedScopes,
          attemptedScopes: graded.attemptedScopes,
          environmentClean: environment.clean,
          environmentFindings: environment.findings.map((f) => f.kind),
          // A contaminated rep is DISCARDED, not counted as a failure — the
          // same rule `retrieval.mjs` applies to a harness fault.
          discarded: !environment.clean,
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
    // Surfaced at the top level so a contaminated batch is impossible to read
    // past. `usableReps` — not `reps` — is the N any conclusion may cite.
    discardedReps: reps.filter((r) => r.discarded).length,
    usableReps: reps.filter((r) => !r.dryRun && !r.discarded).length,
    results: reps,
  };
  await fsp.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  return { outDir, summary };
}

/**
 * The cheapest possible check that a real run would be measuring the model and
 * not the machine: one throwaway prompt in a fully-prepared sandbox, then read
 * the init event back.
 *
 * It costs one trivial model call, and it is the only way to know. On the
 * machine this was written for, the unisolated equivalent loaded ~130 skills
 * and 5 plugins for $1.13 — including the skill that states the golden task's
 * answer. Exits non-zero when the environment is dirty, so it can gate a
 * batch: `node bin/run-eval.mjs preflight && node bin/run-eval.mjs arm0 …`.
 */
async function runPreflight(options) {
  // One throwaway call in a fixed, empty-store arm: the information environment
  // is what is being measured, and it does not vary with the seed, the scope, or
  // whether the sandbox has a git identity. Every one of those flags would have
  // been accepted and dropped on the floor.
  //
  // `--dry-run` is the one that costs money to ignore: spawning is the entire
  // point of preflight, so there is no plan to print without it, and accepting
  // the flag would bill a call while promising not to. It is refused rather
  // than honoured because a dry preflight would exit 0 having checked nothing —
  // and `preflight && arm0` reads that as "the environment is clean".
  refuseUnhonourableFlags(
    options,
    [
      "--seed",
      "--lesson",
      "--scope",
      "--scope-mode",
      "--git",
      "--no-git",
      "--reps",
      "--out",
      "--dry-run",
    ],
    "preflight is a single call in a fixed empty-store arm, it writes no run directory, and the model call IS the check",
  );

  const sandbox = await createSandbox({ keep: options.keep });
  try {
    const arm = await prepareArm(sandbox, { seed: "empty" });
    const run = await runAgent({
      prompt: "Reply with exactly the word READY and nothing else.",
      cwd: sandbox.cwd,
      env: sandbox.childEnv(),
      transcriptPath: path.join(sandbox.artifacts, "preflight.jsonl"),
      command: options.command,
      timeoutMs: options.timeoutMs,
      ...arm.agentOptions,
    });
    const verdict = assertCleanEnvironment(summarizeEnvironment(run), {
      sandboxRoot: sandbox.root,
      expectedHooks: 1,
    });
    return {
      subcommand: "preflight",
      clean: verdict.clean,
      verifiable: verdict.verifiable,
      verdict: describeEnvironment(verdict),
      findings: verdict.findings,
      environment: verdict.summary,
      costUsd: run.summary.costUsd,
      argv: run.argv,
    };
  } finally {
    await sandbox.dispose();
  }
}

async function runProbe(options) {
  // probe builds ONE arm and reads the hook's injection back; it spawns no
  // model and writes no run directory. Everything to do with running the agent
  // or collecting artifacts would therefore be accepted and dropped —
  // `--dry-run` most misleadingly of all, since probe is already dry.
  refuseUnhonourableFlags(
    options,
    ["--reps", "--out", "--timeout", "--command", "--dry-run"],
    "probe builds one arm, spawns no model, writes no run directory and is already dry",
  );

  const sandbox = await createSandbox({ keep: options.keep });
  try {
    const arm = await prepareArm(sandbox, {
      seed: options.seed,
      lesson: options.lesson,
      scope: options.scope,
      scopeMode: options.scopeMode,
      git: options.git,
    });
    const injection = await readInjectedLessons(sandbox);
    const stored = await listAll(sandbox, [
      ...new Set([...arm.derived.readOrder, arm.targetScope]),
    ]);
    const seededKey = arm.seeded.seeded[0] ? arm.seeded.seeded[0].key : null;

    return {
      subcommand: "probe",
      seed: options.seed,
      scopeMode: arm.scopeMode,
      scope: arm.targetScope,
      gitInitialized: arm.gitInitialized,
      readOrder: arm.derived.readOrder,
      // The headline: is the seeded scope one the hook can even see here?
      injectable: arm.injectable,
      seeded: arm.seeded.seeded,
      mcpConfig: arm.mcp.config,
      allowedTools: arm.mcp.allowedTools,
      hookFile: arm.hookInstall.file,
      hookEvents: arm.hookInstall.events,
      injectedHeader: injection.header,
      injectedCount: injection.lessons.length,
      injected: injection.lessons,
      retrieval: seededKey
        ? classifyRetrieval({
            injection,
            storeEntries: stored,
            key: seededKey,
          })
        : null,
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
  if (options.subcommand === "preflight") {
    const result = await runPreflight(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.clean ? 0 : 1;
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
