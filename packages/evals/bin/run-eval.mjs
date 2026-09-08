#!/usr/bin/env node
// Live eval runner. THIS IS NOT A TEST.
//
// Every subcommand here spends real model tokens against `claude -p`, takes
// minutes, and is inherently flaky. It is therefore never invoked from
// `node --test` — `pnpm nx test evals` covers the pure logic only — and it
// GATES NOTHING. That, not "it never runs in CI", is the invariant.
//
// It DOES now run in CI, on demand and on a label, because a GitHub Actions
// runner is the clean-environment machine this harness needs: no user-level
// `~/.claude`, so none of the developer hooks, skills or plugins that
// `environment.mjs` discards a rep for, and a non-root user, so
// `bypassPermissions` is accepted rather than refused.
// `.github/workflows/evals.yml` is the caller; `runnable.mjs` is what makes it
// safe — a fork PR, or a repository before the secret exists, SKIPS rather
// than failing for a reason unrelated to the change.
//
// The one exception is `probe`, which spawns no model at all: it seeds the
// store, installs the real hook and prints what the hook actually injected. It
// is here rather than in the test suite because it is a diagnostic you run
// against a store you are curious about, not an assertion.
//
// Subcommands (later PRs fill in the rest):
//   golden    arms 0/A/B/C, graded and COMPARED — the whole experiment
//   variants  which FRAMING teaches best, on-target AND off-target
//   arm0      one attempt against an EMPTY store — the "no memory" baseline
//   probe     seed + install the hook + print the injected set (no model)
//   scale   corpus size x lesson position sweep     (shipped as a node --test
//           suite, `test/relevance/sweep.test.mjs`, not as a subcommand)
//   review  pr-reviewer control vs treatment on PR #395               (PR6)
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TIMEOUT_MS,
  MODEL_UNDER_TEST,
  runAgent,
} from "../src/harness/agent.mjs";
import { SCOPE_MODES, SEED_SOURCES, prepareArm } from "../src/harness/arm.mjs";
import {
  assessRunnability,
  describeRunnability,
} from "../src/harness/runnable.mjs";
import {
  VARIANT_IDS,
  describeVariant,
  rankVariants,
  renderVariant,
  scoreVariant,
  summarizeCell,
  variantById,
} from "../src/harness/variants.mjs";
import {
  ARM_0,
  ARM_A,
  ARM_C,
  GOLDEN_ARMS,
  armById,
  armCPrompt,
  armPlan,
  compareArms,
  describeComparison,
  resolveArmSelection,
  summarizeArm,
  transcriptDigest,
} from "../src/harness/golden.mjs";
import {
  assertCleanEnvironment,
  describeEnvironment,
  summarizeEnvironment,
} from "../src/grading/environment.mjs";
import { gradeSandbox } from "../src/grading/grade.mjs";
import { readInjectedLessons } from "../src/sandbox/hook-install.mjs";
import { classifyRetrieval } from "../src/grading/retrieval.mjs";
import { createSandbox } from "../src/sandbox/sandbox.mjs";
import { harvestOrganicLesson, listAll } from "../src/sandbox/store-setup.mjs";
import { taskById } from "../src/harness/task.mjs";

const USAGE = `Usage: node bin/run-eval.mjs <subcommand> [options]

Subcommands:
  golden               The WHOLE experiment: arms 0 / A / B / C, graded, then
                       compared. This is the subcommand that answers "does a
                       stored, loaded lesson make the agent do better work?" —
                       arm0 alone cannot, because that answer is a DIFFERENCE
                       between two arms. B-organic is SKIPPED (with a stated
                       reason) unless --lesson-file supplies the lesson the loop
                       would have saved; it is never substituted with the
                       canonical one. Narrow the spend with --arm; a selection
                       without arm A carries no lift, by construction.
  variants             Which FRAMING of one fact teaches best, and what does it
                       cost? Crosses the lesson ladder (rule-only … padded)
                       against an ON-TARGET task and an OFF-TARGET one, so a
                       wording is charged for the neighbouring tasks it
                       misdirects and not only credited for the one it helps.
                       Reports a net lift and a tokens-per-point cost. This is
                       the expensive subcommand: (variants x tasks + tasks) x
                       reps model calls — 60 at the defaults. Narrow it with
                       --variant, or halve it with --skip-off-target (which
                       gives up the net number, not just some detail).
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
  --model <id>         Model under test (default ${MODEL_UNDER_TEST}). Changing
                       it mid-batch makes the arms incomparable; prefer a new run.
  --permission-mode <m> Passed to claude (default bypassPermissions). The CLI
                       REFUSES bypassPermissions under root/sudo, so container
                       runs (CI, Docker, cloud sandboxes) need e.g. acceptEdits.
  --lesson-file <path> golden: the organic lesson, read from a file. Without it
                       (or --lesson) the B-organic arm is skipped, never faked.
  --arm <id>           golden: run only these arms (repeatable). Known ids:
                       ${GOLDEN_ARMS.map((a) => a.id).join(", ")}. Empty means
                       every arm. The cheapest real golden is one arm at
                       --reps 1. Two rules: arm C needs arm 0 (it re-reads its
                       transcript) and is refused without it; a selection
                       WITHOUT arm A reports no lift at all, because a lift is
                       a difference against the baseline and the baseline did
                       not run — the comparison says so rather than printing 0.
  --variant <id>       variants: run only these rows (repeatable). Known ids:
                       ${VARIANT_IDS.join(", ")}.
  --skip-off-target    variants: run the on-target task only. Halves the cost
                       and gives up the NET value — the resulting lifts cannot
                       see what a framing costs on tasks it is not about.
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
  --skip-if-unavailable
                       Exit 0 with a "skipped" report when a live run cannot
                       start (no agent binary, no credential, or a permission
                       mode the CLI would refuse) instead of failing. For CI:
                       a fork PR and a repository without the secret must not
                       go red for a reason unrelated to the change. Locally,
                       leave it off — a silent exit 0 tells you nothing.
  -h, --help           Show this help.
`;

export function parseArgs(argv) {
  const [first, ...tail] = argv;
  // `--help` in the FIRST position is a request for help, not a subcommand
  // named "--help". Reading it as one printed the usage and exited 2, which is
  // the code a caller uses to detect a mistake — so a script that ran
  // `run-eval.mjs --help` to show its own users the options failed on it.
  const askedForHelp = first === "-h" || first === "--help";
  const rest = tail;
  const options = {
    subcommand: askedForHelp ? null : first || null,
    help: askedForHelp,
    reps: 3,
    out: ".eval-out",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    command: DEFAULT_AGENT_COMMAND,
    model: MODEL_UNDER_TEST,
    // `bypassPermissions` is the right default for a throwaway sandbox, but the
    // CLI REFUSES it under root/sudo — so every container run (CI, Docker, a
    // cloud sandbox) died with an empty transcript until this became settable.
    permissionMode: DEFAULT_PERMISSION_MODE,
    seed: "canonical",
    lesson: null,
    lessonFile: null,
    // Repeatable, and EMPTY means "every variant" — an explicit list is a
    // narrowing, so the difference between "asked for none" and "asked for all"
    // never has to be inferred from a sentinel.
    variants: [],
    // The same shape, for golden's arms. The two cost dials are deliberately
    // symmetric: one is `--variant` on the variants ladder, the other `--arm`
    // on the golden arms, and neither needs its own mental model.
    arms: [],
    skipOffTarget: false,
    scope: null,
    scopeMode: "branch",
    git: null,
    keep: false,
    dryRun: false,
    skipIfUnavailable: false,
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
      case "--model":
        options.model = rest[++i];
        break;
      case "--permission-mode":
        options.permissionMode = rest[++i];
        break;
      case "--lesson-file":
        options.lessonFile = rest[++i];
        break;
      case "--variant":
        options.variants.push(rest[++i]);
        break;
      case "--arm":
        options.arms.push(rest[++i]);
        break;
      case "--skip-off-target":
        options.skipOffTarget = true;
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
      case "--skip-if-unavailable":
        options.skipIfUnavailable = true;
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
  // Both are passed straight to `claude`, so an empty value would build an argv
  // with a dangling flag and fail in a way that reads as a model problem.
  for (const [flag, value] of [
    ["--model", options.model],
    ["--permission-mode", options.permissionMode],
  ]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${flag} requires a non-empty value`);
    }
  }
  // A `--variant` with no value pushes `undefined` and would reach the row
  // loop as a cell whose id renders "undefined-branch-scope" — a run that costs
  // real calls and produces an unreadable artifact.
  if (options.variants.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new Error("--variant requires a non-empty variant id");
  }
  // Same trap as `--variant`: a bare `--arm` pushes `undefined`, which would
  // reach `resolveArmSelection` as an id and be refused there — but with a
  // message about an unknown arm rather than about the missing value.
  if (options.arms.some((a) => typeof a !== "string" || a.trim() === "")) {
    throw new Error("--arm requires a non-empty arm id");
  }
  if (options.lesson && options.lessonFile) {
    throw new Error(
      "--lesson and --lesson-file both supply the organic lesson; pass one.",
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

/**
 * The agent-level overrides a subcommand must forward on EVERY call.
 *
 * Assembled once rather than spread by hand at each call site, for the same
 * reason `prepareArm` assembles an arm's world in one place: a flag honoured in
 * three of four call sites is worse than one honoured nowhere, because the
 * inconsistency is invisible in the result.
 */
function agentOverrides(options) {
  return { model: options.model, permissionMode: options.permissionMode };
}

/** Read the operator-supplied organic lesson, from either affordance. */
async function readOrganicLesson(options) {
  if (options.lesson) return options.lesson;
  if (options.lessonFile) {
    const text = await fsp.readFile(path.resolve(options.lessonFile), "utf8");
    if (text.trim() === "") {
      throw new Error(`--lesson-file ${options.lessonFile} is empty`);
    }
    return text.trim();
  }
  return null;
}

/**
 * Run ONE repetition of one arm: build its world, spawn the agent, verify the
 * information environment, grade the store, and classify retrieval.
 *
 * Every arm goes through this one function. That is the experimental control —
 * arms that are prepared and graded by separate code paths drift apart in some
 * detail nobody is watching, and the difference between them stops meaning what
 * the report says it means.
 */
async function runRep({
  arm,
  options,
  sandbox,
  repDir,
  task,
  prompt,
  lesson,
  lessonKey = null,
  // Where the lesson is SEEDED, when that is not the scope being graded.
  //
  // golden leaves this null: seeding at the graded target IS arm B's
  // definition, and a mismatch there could only score a failure. The variant
  // experiment must separate the two — it runs one lesson against two tasks
  // with two different targets, so the lesson is seeded once at `global` and
  // the grading target comes from the task. Keeping the override explicit
  // means golden's guard is unchanged rather than loosened for everyone.
  seedScope = null,
  seedScopeMode = null,
  git = undefined,
}) {
  const prepared = await prepareArm(sandbox, {
    seed: arm.seed,
    lesson,
    lessonKey,
    scopeMode: seedScopeMode || options.scopeMode,
    scope: seedScope || options.scope,
    git: git === undefined ? options.git : git,
    allowWrite: arm.allowWrite,
  });
  const expectedScope = seedScope || task.targetScope;
  if (prepared.targetScope !== expectedScope) {
    throw new Error(
      `this run seeds at ${expectedScope}, but the scope options resolved to ` +
        `${prepared.targetScope}; a run with this combination could only ` +
        `score a failure.`,
    );
  }
  await fsp.mkdir(repDir, { recursive: true });

  // Wall-clock bounds for the rep, so an exported trace has REAL timestamps
  // rather than a synthetic waterfall. `wallMs` alone gives a duration but no
  // position, and a span placed by guesswork is worse than none: it reads as
  // evidence about when the model ran.
  const startedAt = new Date().toISOString();
  const run = await runAgent({
    prompt,
    cwd: sandbox.cwd,
    env: sandbox.childEnv(),
    transcriptPath: path.join(repDir, "transcript.jsonl"),
    command: options.command,
    timeoutMs: options.timeoutMs,
    ...prepared.agentOptions,
    ...agentOverrides(options),
  });

  const environment = assertCleanEnvironment(summarizeEnvironment(run), {
    sandboxRoot: sandbox.root,
    expectedHooks: prepared.hookInstall ? 1 : 0,
  });
  // Grade BEFORE teardown — the store is the evidence.
  const graded = await gradeSandbox(sandbox, {
    transcriptText: run.transcriptText,
    target: task.targetScope,
  });

  // Retrieval is only a question for a SEEDED arm. Asking it of arm A would
  // report `absent` — the harness-fault state — for an arm whose empty store is
  // the entire point, and `isUsable` would then discard every control rep.
  const seededKey = prepared.seeded.seeded[0]
    ? prepared.seeded.seeded[0].key
    : null;
  let retrieval = null;
  if (seededKey) {
    const injection = await readInjectedLessons(sandbox);
    const stored = await listAll(sandbox, [
      ...new Set([...prepared.derived.readOrder, prepared.targetScope]),
    ]);
    retrieval = classifyRetrieval({
      injection,
      storeEntries: stored,
      key: seededKey,
    });
  }

  if (run.stderr) {
    await fsp.writeFile(path.join(repDir, "stderr.log"), run.stderr);
  }
  await fsp.writeFile(
    path.join(repDir, "grade.json"),
    JSON.stringify(graded, null, 2),
  );
  await fsp.writeFile(
    path.join(repDir, "environment.json"),
    JSON.stringify(environment, null, 2),
  );

  return {
    run,
    prepared,
    record: {
      arm: arm.id,
      seed: arm.seed,
      task: task.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      model: options.model,
      targetScope: task.targetScope,
      ...run.summary,
      success: graded.success,
      score: graded.score,
      repeatedMistake: graded.repeatedMistake,
      mistakes: graded.mistakes,
      storedScopes: graded.storedScopes,
      attemptedScopes: graded.attemptedScopes,
      retrieval,
      environmentClean: environment.clean,
      environmentFindings: environment.findings.map((f) => f.kind),
      discarded: !environment.clean,
      wallMs: run.wallMs,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
    },
  };
}

/**
 * What a run actually cost, summed across its groups.
 *
 * Reported so a CI job that spends real money says how much, in the artifact
 * rather than only in a billing dashboard a month later. `null` when nothing
 * was billed (a dry run, or a skipped one) — never `0`, which would read as
 * "this was free".
 */
function totalCostUsd(summaries) {
  const billed = summaries.filter((s) => typeof s.costUsd === "number");
  return billed.length > 0
    ? billed.reduce((sum, s) => sum + s.costUsd, 0)
    : null;
}

// Stands in for arm 0's transcript under `--dry-run`, where no arm 0 ran. It
// is only ever tested for truthiness (`Boolean(priorDigest)`); the arm loop
// skips `armCPrompt` under `--dry-run`, so it can never reach a model.
const DRY_RUN_DIGEST = "(dry-run: arm 0 was planned, not run)";
// Arm B-organic's counterpart. Shaped like a real harvest so the summary's
// provenance block stays well-formed instead of spreading `undefined`s, and
// self-describing for the same reason the digest above is.
const DRY_RUN_HARVEST = Object.freeze({
  value: "(dry-run: arm 0's lesson was planned, not harvested)",
  key: "(dry-run)",
  scope: "(dry-run)",
  entries: 0,
});

/**
 * The golden experiment. Arms 0 / A / B / C, then the comparison.
 *
 * Arm 0 runs FIRST and alone, because two later arms are built from what it
 * produced: arm C re-reads its transcript, and the organic lesson is the
 * wording a real loop would have saved after it. The remaining arms are
 * independent of each other and differ only in their store.
 */
async function runGolden(options) {
  // Each arm's seed is part of the experiment's definition, not a knob: a
  // `--seed canonical` that silently applied to every arm would make arm A a
  // second arm B and report a lift of zero as a finding about memory.
  refuseUnhonourableFlags(
    options,
    ["--seed"],
    "golden defines each arm's own store",
    "the organic lesson goes in --lesson-file",
  );
  // The variants ladder's dials, typed at the arms experiment. Refused rather
  // than ignored for the reason every other refusal here exists: a caller who
  // narrowed with `--variant` and got all four arms reads the bill as the
  // harness misbehaving, and the cost of finding out is a paid run.
  refuseUnhonourableFlags(
    options,
    ["--variant", "--skip-off-target"],
    "golden runs ARMS, not the variants ladder",
    "narrow the arms with --arm <id>",
  );
  // Resolved BEFORE the sandbox and before `requireRunnable` has spent
  // anything: an unknown id or a C-without-0 selection is an argument mistake,
  // and the whole point of the flag is to spend less.
  const selectedArms = resolveArmSelection(options.arms);
  const narrowed = options.arms.length > 0;

  requireRunnable(options);

  const id = runId();
  const outDir = path.resolve(options.out, `golden-${id}`);
  const task = taskById("branch-scope");
  const suppliedLesson = await readOrganicLesson(options);

  await fsp.mkdir(outDir, { recursive: true });

  const perArm = new Map();
  let priorDigest = "";
  // What arm 0 wrote, harvested from its own store. Only consulted when the
  // operator supplied nothing — an explicit --lesson/--lesson-file is a
  // deliberate choice of material and always wins over a harvest.
  let harvested = null;

  // Arm 0 first — it is the only source of the prior transcript. Skipping it
  // when it was not selected is the ENTIRE saving of `--arm`: leaving it
  // unconditional would charge for it on every subset run, and arm C is
  // refused up front rather than silently pulling it back in.
  const armsToRun = selectedArms.includes(ARM_0) ? [armById(ARM_0)] : [];
  for (let rep = 1; armsToRun.length > 0 && rep <= options.reps; rep++) {
    const sandbox = await createSandbox({ keep: options.keep });
    try {
      const repDir = path.join(outDir, `arm-${ARM_0}`, `rep-${rep}`);
      if (options.dryRun) {
        perArm.set(ARM_0, [
          ...(perArm.get(ARM_0) || []),
          { arm: ARM_0, rep, dryRun: true },
        ]);
        // A dry run PLANS; it does not spend. A live arm 0 would have produced
        // a transcript right here, so the plan has to show arm C running —
        // otherwise the free offline tier reports arm C skipped for a reason
        // ("arm 0 produced no transcript") that is an artefact of the dry run
        // rather than a fact about the arms, and the one tier that costs
        // nothing structurally cannot exercise arm C's wiring.
        //
        // Safe as a sentinel: the arm loop below `continue`s past `armCPrompt`
        // under `--dry-run`, so this value is only ever read through
        // `Boolean(priorDigest)` and never reaches a prompt.
        if (!priorDigest) priorDigest = DRY_RUN_DIGEST;
        // Same artefact, same fix: without this the plan reports B-organic
        // skipped for "arm 0 was not run, or ran and wrote nothing to harvest"
        // — both clauses false under a dry run that planned arm 0.
        if (!suppliedLesson && !harvested) harvested = DRY_RUN_HARVEST;
        continue;
      }
      const { run, record } = await runRep({
        arm: armsToRun[0],
        options,
        sandbox,
        repDir,
        task,
        prompt: task.prompt(),
        lesson: null,
      });
      perArm.set(ARM_0, [...(perArm.get(ARM_0) || []), { rep, ...record }]);
      // Keep the FIRST arm-0 transcript as arm C's material: arm C must read
      // one attempt, and averaging or concatenating several would give it
      // strictly more information than the single retry the arms model.
      if (!priorDigest) priorDigest = transcriptDigest(run.transcriptText);
      // And the FIRST arm-0 lesson as arm B-organic's, on the same rule and
      // for the same reason. Harvested before `dispose()` — the sandbox store
      // is the only place this text exists.
      if (!suppliedLesson && !harvested) {
        harvested = await harvestOrganicLesson(sandbox);
      }
    } finally {
      await sandbox.dispose();
    }
  }

  // The operator's own material always wins; the harvest is the fallback that
  // makes the arm reachable at all. `null` for both means the arm is skipped —
  // the canonical lesson is never substituted here, at either layer.
  const organicLesson =
    suppliedLesson || (harvested && harvested.value) || null;
  const organicSource = suppliedLesson
    ? "operator"
    : harvested
      ? "arm-0"
      : null;

  const { run: plannedArms, skipped } = armPlan({
    organicLesson: Boolean(organicLesson),
    priorTranscript: Boolean(priorDigest),
    // `null`, not the full id list, when nothing was narrowed: the skip reason
    // for an unselected arm names the selection, and "not selected — this run
    // asked for 0, A, B-organic, B-canonical, C" is a sentence no unnarrowed
    // run should ever be able to produce.
    selected: narrowed ? selectedArms : null,
  });

  for (const arm of plannedArms) {
    if (arm.id === ARM_0) continue;
    for (let rep = 1; rep <= options.reps; rep++) {
      const sandbox = await createSandbox({ keep: options.keep });
      try {
        const repDir = path.join(outDir, `arm-${arm.id}`, `rep-${rep}`);
        if (options.dryRun) {
          perArm.set(arm.id, [
            ...(perArm.get(arm.id) || []),
            { arm: arm.id, rep, dryRun: true },
          ]);
          continue;
        }
        const prompt =
          arm.id === ARM_C
            ? armCPrompt(task.prompt(), priorDigest)
            : task.prompt();
        const { record } = await runRep({
          arm,
          options,
          sandbox,
          repDir,
          task,
          prompt,
          lesson: arm.seed === "organic" ? organicLesson : null,
        });
        perArm.set(arm.id, [...(perArm.get(arm.id) || []), { rep, ...record }]);
      } finally {
        await sandbox.dispose();
      }
    }
  }

  const summaries = [...perArm.entries()].map(([armId, reps]) =>
    summarizeArm(armId, reps),
  );
  const comparisons = compareArms(summaries);

  const summary = {
    subcommand: "golden",
    runId: id,
    model: options.model,
    repsRequested: options.reps,
    // `null` means the whole experiment ran. A subset is recorded ON THE
    // ARTIFACT rather than left to be inferred from which arms happen to be
    // present, because "arm A is missing" and "arm A was never asked for" are
    // read very differently by whoever opens this file next.
    armsRequested: narrowed ? selectedArms : null,
    // WHERE arm B-organic's lesson came from. Recorded because the arm's whole
    // claim is that the text is the agent's own: "operator" is a human's file
    // and "arm-0" is this run's own write, and a reader who cannot tell them
    // apart cannot tell whether the number is about the loop or about a person
    // writing a good lesson. `null` means the arm did not run.
    organicLesson: organicSource && {
      source: organicSource,
      chars: organicLesson.length,
      // Present only on a harvest — where in the store it was found, and how
      // many candidates there were, so seeding from one of several is visible.
      ...(harvested && organicSource === "arm-0"
        ? {
            scope: harvested.scope,
            key: harvested.key,
            candidates: harvested.entries,
          }
        : {}),
    },
    caveat:
      `N=${options.reps} per arm is a low-power INDICATOR, not proof. ` +
      `Treat every difference as directional; widening N — not reinterpreting ` +
      `these reps — is the way to a stronger claim.`,
    costUsd: totalCostUsd(summaries),
    skippedArms: skipped,
    arms: summaries,
    comparisons,
    readable: comparisons.map(describeComparison),
    results: Object.fromEntries(perArm),
  };
  await fsp.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  return { outDir, summary };
}

/**
 * The variant experiment: which FRAMING of one fact teaches best, and at what
 * cost in context?
 *
 * Structure — a full crossing of variants × tasks, plus one shared control per
 * task. Every treatment cell seeds ONE lesson at `global`, so the lesson
 * reaches both tasks by the same delivery path and the only thing that differs
 * between two cells in a row is the task, and between two rows is the wording.
 *
 * The control is run ONCE PER TASK and reused across every variant, rather than
 * once per cell. Both readings are defensible; this one buys reps for the arms
 * that actually differ, and it is stated here because a reader comparing two
 * variants is comparing them against the SAME baseline draw, which makes the
 * between-variant differences cleaner than the absolute lifts.
 */
async function runVariants(options) {
  refuseUnhonourableFlags(
    options,
    ["--seed", "--scope", "--scope-mode", "--lesson", "--lesson-file", "--arm"],
    "variants defines its own store, scope and lesson text, and runs no arms",
    "pick rows with --variant <id> instead",
  );
  requireRunnable(options);

  // De-duped: cells are keyed by variant id, so a repeated `--variant full`
  // would push two runs into ONE cell — doubling that row's `usableReps` and
  // the spend behind it while every other row kept `--reps` — and emit the
  // variant twice in the ranking.
  const requested =
    options.variants.length > 0 ? [...new Set(options.variants)] : VARIANT_IDS;
  for (const id of requested) variantById(id); // refuse an unknown id up front

  const id = runId();
  const outDir = path.resolve(options.out, `variants-${id}`);
  const tasks = [taskById("branch-scope")];
  if (!options.skipOffTarget) tasks.push(taskById("repo-scope"));
  // Cells are KEYED by `task.id`, so the read-back below must derive its ids
  // from the same objects rather than repeating the literals. Spelling them
  // twice meant renaming a task silently produced empty cells — every score
  // `comparable: false` across a 60-call run, with nothing failing loudly.
  const onTargetTask = tasks.find((t) => t.role === "on-target");
  const offTargetTask = tasks.find((t) => t.role === "off-target");
  await fsp.mkdir(outDir, { recursive: true });

  // One lesson, one delivery path, two tasks. `global` is injected in any
  // directory, so seeding there holds scope RESOLUTION fixed and leaves the
  // wording as the only variable — retrieval already has its own experiment.
  const seeding = { seedScope: "global", seedScopeMode: "global", git: true };
  const baselineArm = armById(ARM_A);
  const treatmentArm = { id: "B-variant", seed: "organic", allowWrite: false };

  const cells = new Map(); // `${cellId}` -> reps[]
  const push = (cellId, rep) =>
    cells.set(cellId, [...(cells.get(cellId) || []), rep]);

  const runCell = async ({ cellId, arm, task, variant }) => {
    for (let rep = 1; rep <= options.reps; rep++) {
      const sandbox = await createSandbox({ keep: options.keep });
      try {
        const repDir = path.join(outDir, cellId, `rep-${rep}`);
        if (options.dryRun) {
          push(cellId, { cell: cellId, rep, dryRun: true });
          continue;
        }
        const { record } = await runRep({
          arm,
          options,
          sandbox,
          repDir,
          task,
          prompt: task.prompt(),
          lesson: variant ? variant.body : null,
          lessonKey: variant ? variant.key : null,
          ...seeding,
        });
        push(cellId, { rep, variant: variant ? variant.id : null, ...record });
      } finally {
        await sandbox.dispose();
      }
    }
  };

  // Controls first: every variant is scored against them, so a run that dies
  // partway through still has the denominator for whatever finished.
  for (const task of tasks) {
    await runCell({ cellId: `baseline-${task.id}`, arm: baselineArm, task });
  }
  const rendered = requested.map(renderVariant);
  for (const variant of rendered) {
    for (const task of tasks) {
      await runCell({
        cellId: `${variant.id}-${task.id}`,
        arm: treatmentArm,
        task,
        variant,
      });
    }
  }

  const cell = (cellId) => summarizeCell(cellId, cells.get(cellId) || []);
  const offTargetRun = !options.skipOffTarget;
  const scored = rendered.map((variant) =>
    scoreVariant({
      variant,
      onTarget: cell(`${variant.id}-${onTargetTask.id}`),
      offTarget: offTargetRun
        ? cell(`${variant.id}-${offTargetTask.id}`)
        : null,
      baselineOnTarget: cell(`baseline-${onTargetTask.id}`),
      baselineOffTarget: offTargetRun
        ? cell(`baseline-${offTargetTask.id}`)
        : null,
    }),
  );
  const ranked = rankVariants(scored);

  const summary = {
    subcommand: "variants",
    runId: id,
    model: options.model,
    repsRequested: options.reps,
    offTargetRun,
    costUsd: totalCostUsd([...cells.keys()].map((cellId) => cell(cellId))),
    caveat:
      `N=${options.reps} per cell is a low-power INDICATOR, not proof. ` +
      `A ranking at this N orders the variants; it does not establish that ` +
      `the top row beats the second. Widening N — not reinterpreting these ` +
      `reps — is the way to a stronger claim.` +
      (offTargetRun
        ? ""
        : ` The off-target task was SKIPPED, so no net value was computed: ` +
          `these are on-target lifts only, and a framing that misdirects ` +
          `other tasks looks free here.`),
    variants: rendered.map(({ body, ...meta }) => ({
      ...meta,
      bodyChars: body.length,
    })),
    cells: Object.fromEntries(
      [...cells.keys()].map((cellId) => [cellId, cell(cellId)]),
    ),
    ranked,
    readable: ranked.map(describeVariant),
    results: Object.fromEntries(cells),
  };
  await fsp.writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  return { outDir, summary };
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
  // arm0 IS one arm, so a narrowing flag has nothing to narrow. It is refused
  // rather than ignored because `--arm B-canonical` on this subcommand looks
  // exactly like a request for the seeded arm and would silently deliver the
  // empty-store one instead — a paid run answering a different question.
  refuseUnhonourableFlags(
    options,
    ["--arm", "--variant", "--skip-off-target"],
    "arm0 is a single fixed arm and selects nothing",
    'narrow the arms with "golden --arm <id>"',
  );
  requireRunnable(options);

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
        // The model that will actually be SPAWNED, not the default. These must
        // be the same value: `agentOverrides` passes `options.model` to the
        // child, so recording the constant made `arm0 --model X` run X and
        // report the default — a lie that now reaches `lorekit.eval.model`.
        model: options.model,
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
          ...agentOverrides(options),
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
          finishedAt: new Date().toISOString(),
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
    model: options.model,
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
      "--arm",
      "--variant",
      "--skip-off-target",
    ],
    "preflight is a single call in a fixed empty-store arm, it writes no run directory, and the model call IS the check",
  );
  requireRunnable(options);

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
      ...agentOverrides(options),
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
      // The agent's OWN failure, surfaced rather than left on the floor.
      //
      // `no-init-event` describes the symptom (nothing came back) and says
      // nothing about the cause, so a run that died before it started — a
      // rejected flag, an unservable model pin, a missing binary — reported as
      // an unverifiable environment and sent the reader to look at hooks and
      // plugins. The one line `claude` wrote to stderr names the real cause
      // ("--dangerously-skip-permissions cannot be used with root/sudo"), and
      // `arm0` was already writing it to `stderr.log` while preflight, the
      // subcommand whose whole job is to diagnose, discarded it.
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stderr: run.stderr ? run.stderr.trim() : null,
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
    [
      "--reps",
      "--out",
      "--timeout",
      "--command",
      "--dry-run",
      "--arm",
      "--variant",
      "--skip-off-target",
    ],
    "probe builds one arm, spawns no model, writes no run directory, selects nothing and is already dry",
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

/** Thrown by `requireRunnable`; `main` turns it into a refusal or a skip. */
class RunUnavailable extends Error {
  constructor(assessment) {
    super(describeRunnability(assessment));
    this.name = "RunUnavailable";
    this.assessment = assessment;
  }
}

/**
 * Refuse to start a subcommand that spawns a model when it cannot.
 *
 * Called by each live subcommand as its SECOND statement, immediately after its
 * own `refuseUnhonourableFlags`. The order is load-bearing in both directions:
 *
 *   • A flag this subcommand cannot honour is a caller error, true in every
 *     environment, and its message is the actionable one — reporting "no
 *     credential" to someone who typed `preflight --scope-mode repo` sends them
 *     to add a secret that will not fix anything.
 *   • Worse under `--skip-if-unavailable`, which CI always passes: gating first
 *     would turn a malformed invocation into exit 0 and a "skipped" report, so
 *     a workflow could ship a wrong flag combination and stay green forever.
 *
 * `probe` never calls this — it seeds, installs the hook and reads what was
 * injected without an agent, so it is the one diagnostic that stays useful on a
 * machine with no credential at all. `--dry-run` is exempt for the same reason:
 * refusing to print a plan because there is no credential would break the one
 * affordance that works everywhere.
 */
function requireRunnable(options) {
  if (options.dryRun) return;
  const assessment = assessRunnability({
    command: options.command,
    permissionMode: options.permissionMode,
  });
  if (!assessment.runnable) throw new RunUnavailable(assessment);
}

/** Report an unstartable run: exit 0 with a stated reason, or refuse. */
function reportUnavailable(options, assessment) {
  if (!options.skipIfUnavailable) {
    throw new Error(
      `${describeRunnability(assessment)}\n\nPass --skip-if-unavailable to ` +
        `exit 0 with a skipped report instead (that is what CI does).`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        subcommand: options.subcommand,
        skipped: true,
        // The reason travels IN the artifact. A skipped CI job whose reason
        // lives only in a log line reads, months later, as a run that passed.
        reasons: assessment.reasons,
        readable: describeRunnability(assessment),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.subcommand) {
    process.stdout.write(USAGE);
    return 0;
  }
  // Each live subcommand decides for itself that it can start, AFTER refusing
  // any flag it cannot honour (see `requireRunnable`). Catching the verdict
  // here rather than pre-checking it keeps that order and keeps the skip
  // report in one place.
  try {
    return await dispatch(options);
  } catch (err) {
    if (!(err instanceof RunUnavailable)) throw err;
    return reportUnavailable(options, err.assessment);
  }
}

async function dispatch(options) {
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
  if (options.subcommand === "golden") {
    const { outDir, summary } = await runGolden(options);
    process.stdout.write(
      `${JSON.stringify(summary, null, 2)}\n\nartifacts: ${outDir}\n`,
    );
    return 0;
  }
  if (options.subcommand === "variants") {
    const { outDir, summary } = await runVariants(options);
    process.stdout.write(
      `${JSON.stringify(summary, null, 2)}\n\nartifacts: ${outDir}\n`,
    );
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
