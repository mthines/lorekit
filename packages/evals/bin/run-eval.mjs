#!/usr/bin/env node
// Live eval runner. THIS IS NOT A TEST.
//
// Every subcommand here spends real model tokens against `claude -p`, takes
// minutes, and is inherently flaky. It is therefore never invoked from
// `node --test` and never from CI — `pnpm nx test evals` covers the pure logic
// only, and the harness gates nothing until the signal is shown to be stable.
//
// Subcommands (later PRs fill in the rest):
//   arm0    one attempt against an EMPTY store — the "no memory" baseline
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
import { createSandbox } from "../src/sandbox.mjs";

// PR3 replaces this with the real golden task from `src/task.mjs`. Until then
// arm0 exercises the plumbing end to end with a prompt that is cheap and has an
// unambiguous outcome.
const PLACEHOLDER_PROMPT =
  "Reply with exactly the word READY and nothing else. Do not use any tools.";

const USAGE = `Usage: node bin/run-eval.mjs <subcommand> [options]

Subcommands:
  arm0                 One live attempt against an empty scratch store.

Options:
  --reps <n>           Repetitions (default 3; N=3 is a low-power INDICATOR).
  --out <dir>          Artifact directory (default ./.eval-out).
  --timeout <ms>       Hard wall-clock ceiling per attempt (default ${DEFAULT_TIMEOUT_MS}).
  --command <bin>      Agent binary (default "claude"; override for smoke tests).
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

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.subcommand) {
    process.stdout.write(USAGE);
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
