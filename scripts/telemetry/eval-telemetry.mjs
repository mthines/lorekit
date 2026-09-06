/**
 * Ship an eval run to Dash0 as OTLP traces + metrics, under `service.name=eval`.
 *
 * Third sibling of `sweep-telemetry.mjs` and `load-telemetry.mjs`, on the same
 * `otlp-export.mjs` base, so the resource identity, the int64/double split and
 * the POST are shared rather than written a third time — a metric on a
 * different resource than its spans silently stops correlating.
 *
 * WHY `eval` IS ITS OWN SERVICE
 * An eval is synthetic traffic that measures the PRODUCT rather than serving
 * it, so its numbers must never mix into the `api` / `cli` / `web` / `mcp`
 * dashboards — the same reason `sweep` and `load` are their own services.
 * `deployment.environment.name` is hardcoded `test` by `resourceAttributes`
 * for the same reason, and no caller can override it.
 *
 * WHY IT READS `summary.json` RATHER THAN RUNNING INSIDE THE HARNESS
 * The harness gates nothing and must never fail because telemetry could not be
 * shipped — it has just spent tens of minutes and real money computing the
 * result. Keeping the exporter downstream of the artifact makes that structural
 * rather than a promise: the run is already on disk and already reported before
 * this file executes, and the export is a separate, separately-failing step.
 * It also means a run exported months later produces the same payload.
 *
 * WHAT IT EMITS
 *
 * Traces — one root `lorekit.eval` span for the run, with one child span per
 * REP. A rep is the unit of the experiment and there are tens of them, not
 * thousands, so the waterfall IS the run: which arm/cell ran when, how long the
 * model took, and which reps were discarded.
 *
 * Metrics — gauges, stamped at export time. Each is a measurement of one run at
 * one commit, not something that accumulates:
 *   lorekit.eval.success_rate    1        {arm, task, variant}
 *   lorekit.eval.mean_score      1        {arm, task, variant}
 *   lorekit.eval.reps            {rep}    {arm, task, variant, state}
 *   lorekit.eval.cost            {USD}    {arm, task, variant}
 *   lorekit.eval.duration        s        {arm, task, variant} — mean wall time
 *   lorekit.eval.lift            1        {arm|variant, baseline, measure}
 *   lorekit.eval.tokens_per_point {token} {variant} — the framing's cost
 *
 * TWO INVARIANTS INHERITED FROM THE HARNESS, AND THEY DISAGREE ON PURPOSE
 *   • Every RATE is over `usableReps`, never `reps`. A contaminated rep is
 *     discarded, not evidence, and a series that averaged it in would be a
 *     number about the machine wearing the label of a number about the model.
 *     A cell with zero usable reps emits NO rate datapoint — never `0.0`, which
 *     reads as "the arm failed" rather than "nothing was measured".
 *   • `cost` is over every rep that was BILLED, discarded ones included. They
 *     were charged for, and pricing only the usable reps would understate what
 *     the experiment cost exactly when it went most wrong.
 *
 * The aggregates are READ from the summary, never recomputed here. The harness
 * owns `summarizeArm` / `scoreVariant`; an exporter with its own copy of the
 * arithmetic would keep publishing numbers after the definitions moved, which
 * is the one failure that makes every series it writes meaningless.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  randHex,
  resolveTelemetryConfig,
} from "../../packages/cli/src/telemetry/telemetry.mjs";
import {
  SPAN_KIND_INTERNAL,
  gauge,
  gaugeMetric,
  metricsEnvelope,
  post,
  spansEnvelope,
  toOtlpAttributes,
  toUnixNano,
} from "./otlp-export.mjs";

const SERVICE_NAME = "eval";

/** OTLP status codes: 1 = OK, 2 = ERROR. */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/**
 * Every rep in the run, flattened, each carrying the cell it belongs to.
 *
 * Three `results` shapes exist because three subcommands produce them —
 * `arm0` an array, `golden` a map keyed by arm, `variants` a map keyed by
 * cell id — and all three are handled rather than one being privileged:
 * an exporter that silently produced an empty trace for a shape it did not
 * recognise would look exactly like a run that emitted nothing.
 *
 * Dry-run reps are dropped: they describe a plan, not a measurement.
 */
export function flattenReps(summary) {
  const results = (summary && summary.results) || {};
  const groups = Array.isArray(results)
    ? [["", results]]
    : Object.entries(results);
  const out = [];
  for (const [cellId, reps] of groups) {
    if (!Array.isArray(reps)) continue;
    for (const rep of reps) {
      if (!rep || rep.dryRun) continue;
      out.push({ ...rep, cell: rep.cell || cellId || rep.arm || "" });
    }
  }
  return out;
}

/**
 * The bounded dimensions that identify a cell: which arm, on which task, under
 * which lesson framing.
 *
 * Read off the cell's own REPS rather than parsed out of the cell id. Both
 * halves of a variants id (`full-opaque-key-repo-scope`) contain hyphens, so
 * splitting it is ambiguous — and a dimension guessed wrong routes a datapoint
 * into another variant's series, where it is indistinguishable from data.
 *
 * `variant` is omitted, not set to `"none"`, where there is none: an absent
 * attribute is filtered by `toOtlpAttributes`, so golden's arms do not acquire
 * a dimension that only the variant experiment has.
 */
export function cellDims(reps = [], fallbackId = "") {
  const first = reps.find(Boolean) || {};
  return {
    "lorekit.eval.arm": first.arm ?? fallbackId ?? undefined,
    "lorekit.eval.task": first.task ?? undefined,
    "lorekit.eval.variant": first.variant ?? undefined,
  };
}

/**
 * The per-cell aggregate blocks the summary carries, paired with their reps.
 *
 * `golden` publishes `arms[]` (keyed by `.arm`), `variants` publishes `cells{}`
 * (keyed by cell id). `arm0` publishes neither — it computes no rates at all,
 * because it is one arm and a difference needs two — so it contributes spans
 * and nothing else. That is reported as an absence rather than filled in with
 * an aggregate this file would have had to invent.
 */
export function cellAggregates(summary, reps = flattenReps(summary)) {
  const byCell = new Map();
  for (const rep of reps) {
    byCell.set(rep.cell, [...(byCell.get(rep.cell) || []), rep]);
  }
  const blocks = Array.isArray(summary && summary.arms)
    ? summary.arms.map((a) => [a.arm, a])
    : Object.entries((summary && summary.cells) || {});
  return blocks
    .filter(([, block]) => block && typeof block === "object")
    .map(([cellId, block]) => ({
      cellId,
      block,
      dims: cellDims(byCell.get(cellId) || [], cellId),
    }));
}

/** ISO timestamp → ms, or null. Never NaN: a NaN reaches OTLP as `"NaN000000"`. */
function msOf(iso) {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? ms : null;
}

export function buildTracePayload(summary, nowMs = Date.now()) {
  const traceId = randHex(16);
  const rootSpanId = randHex(8);
  const reps = flattenReps(summary);

  const starts = reps.map((r) => msOf(r.startedAt)).filter((v) => v !== null);
  const ends = reps.map((r) => msOf(r.finishedAt)).filter((v) => v !== null);
  const rootStart = starts.length ? Math.min(...starts) : nowMs;
  const rootEnd = ends.length ? Math.max(...ends) : nowMs;

  const spans = [
    {
      traceId,
      spanId: rootSpanId,
      name: "lorekit.eval",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNano(rootStart),
      endTimeUnixNano: toUnixNano(rootEnd),
      attributes: toOtlpAttributes({
        "lorekit.eval.subcommand": summary.subcommand,
        "lorekit.eval.run_id": summary.runId,
        "lorekit.eval.model": summary.model,
        "lorekit.eval.reps": reps.length,
        // The N a conclusion may cite, on the root, beside the N that ran — the
        // gap between them IS the contamination story.
        "lorekit.eval.usable_reps": reps.filter(isUsable).length,
        "lorekit.eval.discarded_reps": reps.filter((r) => r.discarded).length,
        "lorekit.eval.cost_usd": summary.costUsd ?? undefined,
        // Verbatim, not paraphrased: a reader who finds this trace months from
        // now must meet the low-power caveat without going to the README.
        "lorekit.eval.caveat": summary.caveat,
      }),
      // A run every one of whose reps was discarded produced no evidence, and
      // saying so in the span status is the difference between a trace that
      // reports a null result and one that reports nothing happening.
      status:
        reps.length > 0 && reps.every((r) => r.discarded)
          ? { code: STATUS_ERROR, message: "every rep was discarded" }
          : { code: STATUS_OK },
    },
  ];

  for (const [index, rep] of reps.entries()) {
    const start = msOf(rep.startedAt);
    const wall = typeof rep.wallMs === "number" ? rep.wallMs : 0;
    const end = msOf(rep.finishedAt) ?? (start === null ? null : start + wall);
    // A rep from a summary written before reps carried timestamps still gets a
    // span, laid at the root's start and LABELLED synthetic — the duration is
    // real, the position is not, and the attribute is what keeps the two from
    // being read as the same claim.
    const synthetic = start === null;
    spans.push({
      traceId,
      spanId: randHex(8),
      parentSpanId: rootSpanId,
      name: `lorekit.eval.rep`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNano(synthetic ? rootStart : start),
      endTimeUnixNano: toUnixNano(synthetic ? rootStart + wall : end),
      attributes: toOtlpAttributes({
        ...cellDims([rep], rep.cell),
        "lorekit.eval.cell": rep.cell || undefined,
        "lorekit.eval.rep": rep.rep ?? index + 1,
        "lorekit.eval.seed": rep.seed ?? undefined,
        "lorekit.eval.target_scope": rep.targetScope ?? undefined,
        "lorekit.eval.success": rep.success ?? undefined,
        "lorekit.eval.score": rep.score ?? undefined,
        "lorekit.eval.repeated_mistake": rep.repeatedMistake ?? undefined,
        "lorekit.eval.retrieval_state": rep.retrieval
          ? rep.retrieval.state
          : undefined,
        "lorekit.eval.discarded": rep.discarded ?? false,
        // Why it was discarded, which is the actionable half — `foreign-hooks-fired`
        // is a machine to fix, `no-init-event` is usually a refused flag.
        "lorekit.eval.environment_findings": (rep.environmentFindings || [])
          .join(",")
          .trim()
          ? rep.environmentFindings.join(",")
          : undefined,
        "lorekit.eval.turns": rep.numTurns ?? undefined,
        "lorekit.eval.input_tokens": rep.inputTokens ?? undefined,
        "lorekit.eval.output_tokens": rep.outputTokens ?? undefined,
        "lorekit.eval.cost_usd": rep.costUsd ?? undefined,
        "lorekit.eval.timed_out": rep.timedOut ?? undefined,
        "lorekit.eval.timing": synthetic ? "synthetic" : undefined,
      }),
      // A DISCARDED rep is the error, not a failed one: failing the task is the
      // measurement working. Losing the rep to the environment is the harness
      // failing to measure anything at all.
      status: rep.discarded
        ? {
            code: STATUS_ERROR,
            message: (rep.environmentFindings || []).join(",") || "discarded",
          }
        : { code: STATUS_OK },
    });
  }

  return { traceId, payload: spansEnvelope(SERVICE_NAME, spans) };
}

/**
 * A rep that ran, was not contaminated, and is therefore evidence.
 *
 * MIRRORS `isUsable` in `packages/evals/src/harness/golden.mjs` — the third
 * clause is not optional. A harness fault (`retrieval.state === "absent"`) is
 * excluded there for the same reason contamination is: nothing was measured.
 * Omitting it here made `lorekit.eval.usable_reps` on the root span count a
 * rep the summary's own `usableReps` had already thrown out, so a chart and
 * the artifact it came from reported two different N for one run.
 *
 * Copied rather than imported, following the repo's mirrored-pure-module
 * pattern: this script runs from the repo root against artifacts, and must
 * not take a dependency on a workspace package to read a JSON file.
 */
const RETRIEVAL_ABSENT = "absent";
function isUsable(rep) {
  if (!rep || rep.dryRun || rep.discarded) return false;
  if (rep.retrieval && rep.retrieval.state === RETRIEVAL_ABSENT) return false;
  return true;
}

export function buildMetricsPayload(summary, timeMs = Date.now()) {
  const reps = flattenReps(summary);
  const aggregates = cellAggregates(summary, reps);

  const successRate = [];
  const meanScore = [];
  const repCounts = [];
  const cost = [];
  const duration = [];

  for (const { cellId, block, dims } of aggregates) {
    // A rate over zero usable reps is not zero — it is absent. Emitting 0.0
    // would draw a flat line that reads as a failing arm.
    if (typeof block.successRate === "number") {
      successRate.push(gauge(dims, block.successRate, timeMs));
    }
    if (typeof block.meanScore === "number") {
      meanScore.push(gauge(dims, block.meanScore, timeMs));
    }
    for (const [state, value] of [
      ["usable", block.usableReps],
      ["discarded", block.discardedReps],
      ["ran", block.reps],
    ]) {
      if (typeof value === "number") {
        repCounts.push(
          gauge({ ...dims, "lorekit.eval.rep_state": state }, value, timeMs),
        );
      }
    }
    if (typeof block.costUsd === "number") {
      cost.push(gauge(dims, block.costUsd, timeMs));
    }
    // Mean wall time per rep, in SECONDS as OTLP wants. Over the reps that ran
    // rather than the usable ones: a discarded rep still occupied the runner,
    // and this series answers "what does a batch cost in time".
    const timed = reps.filter(
      (r) => r.cell === cellId && typeof r.wallMs === "number",
    );
    if (timed.length > 0) {
      const mean = timed.reduce((sum, r) => sum + r.wallMs, 0) / timed.length;
      duration.push(gauge(dims, mean / 1000, timeMs));
    }
  }

  // The headline of each experiment, read from whichever block the subcommand
  // produced. Both are plain differences the harness already computed; neither
  // is derived here.
  const lift = [];
  for (const c of summary.comparisons || []) {
    if (!c || !c.comparable) continue;
    for (const [measure, value] of [
      ["success_rate", c.successRateLift],
      ["mean_score", c.meanScoreLift],
      ["repeated_mistake", c.repeatedMistakeDelta],
    ]) {
      if (typeof value === "number") {
        lift.push(
          gauge(
            {
              "lorekit.eval.arm": c.arm,
              "lorekit.eval.baseline": c.baseline,
              "lorekit.eval.measure": measure,
            },
            value,
            timeMs,
          ),
        );
      }
    }
  }
  const tokensPerPoint = [];
  for (const v of summary.ranked || []) {
    if (!v || !v.comparable) continue;
    for (const [measure, value] of [
      ["on_target", v.onTargetLift],
      ["off_target", v.offTargetDelta],
      // The one that matters: on-target lift MINUS off-target regression. A
      // framing is charged for the neighbours it misdirects.
      ["net", v.netLift],
    ]) {
      if (typeof value === "number") {
        lift.push(
          gauge(
            {
              "lorekit.eval.variant": v.variant,
              "lorekit.eval.measure": measure,
            },
            value,
            timeMs,
          ),
        );
      }
    }
    if (typeof v.tokensPerPoint === "number") {
      tokensPerPoint.push(
        gauge(
          {
            "lorekit.eval.variant": v.variant,
            "lorekit.eval.est_tokens": v.estTokens,
          },
          v.tokensPerPoint,
          timeMs,
        ),
      );
    }
  }

  return metricsEnvelope(SERVICE_NAME, [
    gaugeMetric({
      name: "lorekit.eval.success_rate",
      unit: "1",
      description: "Share of USABLE reps that hit the target exactly.",
      points: successRate,
    }),
    gaugeMetric({
      name: "lorekit.eval.mean_score",
      unit: "1",
      description: "Mean graded score (0-100) over usable reps.",
      points: meanScore,
    }),
    gaugeMetric({
      name: "lorekit.eval.reps",
      unit: "{rep}",
      description: "Reps by state: ran, usable, discarded.",
      points: repCounts,
    }),
    gaugeMetric({
      name: "lorekit.eval.cost",
      unit: "{USD}",
      description: "Model spend, over every BILLED rep including discarded.",
      points: cost,
    }),
    gaugeMetric({
      name: "lorekit.eval.duration",
      unit: "s",
      description: "Mean wall-clock time per rep that ran.",
      points: duration,
    }),
    gaugeMetric({
      name: "lorekit.eval.lift",
      unit: "1",
      description: "Treatment minus baseline, as a plain difference.",
      points: lift,
    }),
    gaugeMetric({
      name: "lorekit.eval.tokens_per_point",
      unit: "{token}",
      description: "Estimated lesson tokens per point of net lift.",
      points: tokensPerPoint,
    }),
  ]);
}

/**
 * Build and ship one run. Never throws — the caller has already reported the
 * result, and a failed export must not retroactively fail the experiment.
 */
export async function exportEval({ summary, dryRun }, env = process.env) {
  const timeMs = Date.now();
  const build = () => ({
    traces: buildTracePayload(summary, timeMs),
    metrics: buildMetricsPayload(summary, timeMs),
  });

  // Before resolving a credential, so it works with no token — which is when
  // you most need to inspect what would have been sent.
  if (dryRun) {
    const { traces, metrics } = build();
    return { exported: false, dryRun: true, traces: traces.payload, metrics };
  }

  const cfg = resolveTelemetryConfig(env);
  if (!cfg.enabled) return { exported: false, reason: cfg.reason };

  const { traces, metrics } = build();
  const [t, m] = await Promise.all([
    post(`${cfg.endpoint}/v1/traces`, cfg.headers, traces.payload),
    post(`${cfg.endpoint}/v1/metrics`, cfg.headers, metrics),
  ]);

  return {
    exported: t.ok && m.ok,
    traceId: traces.traceId,
    endpoint: cfg.endpoint,
    spans: traces.payload.resourceSpans[0].scopeSpans[0].spans.length,
    datapoints: metrics.resourceMetrics[0].scopeMetrics[0].metrics.reduce(
      (n, x) => n + x.gauge.dataPoints.length,
      0,
    ),
    errors: [t.error, m.error].filter(Boolean),
  };
}

export { SERVICE_NAME };

// ── CLI ─────────────────────────────────────────────────────────────────────
//
//   node scripts/telemetry/eval-telemetry.mjs <path> [--dry-run]
//
// `<path>` is a `summary.json`, the run directory holding one, or the `--out`
// parent holding several — in which case the NEWEST is exported. Resolving the
// parent is what lets the workflow name a fixed path (`.eval-out`) instead of
// interpolating a run id it does not know.

/** The `summary.json` `<path>` names, or null. Never guesses beyond one level. */
export function resolveSummaryPath(target) {
  if (!target || !fs.existsSync(target)) return null;
  if (fs.statSync(target).isFile()) return target;
  const direct = path.join(target, "summary.json");
  if (fs.existsSync(direct)) return direct;
  // A run id sorts lexicographically by its ISO timestamp, so the last entry is
  // the newest — the same assumption the workflow's step summary makes.
  const runs = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(target, e.name, "summary.json"))
    .filter((p) => fs.existsSync(p))
    .sort();
  return runs.length ? runs[runs.length - 1] : null;
}

async function cli(argv) {
  const dryRun = argv.includes("--dry-run");
  const target = argv.find((a) => !a.startsWith("--"));
  if (!target) {
    process.stderr.write(
      "usage: node scripts/telemetry/eval-telemetry.mjs <summary.json|dir> [--dry-run]\n",
    );
    return 2;
  }
  const file = resolveSummaryPath(target);
  // Not an error. This step runs with `always()`, so a run that skipped for
  // want of a credential reaches it with nothing to export — and turning that
  // into a red step would report a missing secret as a telemetry fault.
  if (!file) {
    process.stdout.write(
      `${JSON.stringify({ exported: false, reason: "no-summary", target }, null, 2)}\n`,
    );
    return 0;
  }
  const summary = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = await exportEval({ summary, dryRun });
  process.stdout.write(`${JSON.stringify({ file, ...result }, null, 2)}\n`);
  // Not being configured is a skip; failing to ship when configured is a fault
  // worth seeing. The eval's own numbers are already in the artifact and the
  // step summary by now, so surfacing this costs nothing that matters.
  return result.errors && result.errors.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    },
  );
}
