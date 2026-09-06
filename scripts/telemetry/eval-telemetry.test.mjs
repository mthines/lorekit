// The eval exporter's OTLP payloads.
//
// Nothing here spawns a model or reaches the network: every assertion is
// against a payload built from a fixture summary, which is the whole reason the
// exporter reads `summary.json` instead of living inside the harness.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SERVICE_NAME,
  buildMetricsPayload,
  buildTracePayload,
  cellAggregates,
  cellDims,
  exportEval,
  flattenReps,
  resolveSummaryPath,
} from "./eval-telemetry.mjs";

const T0 = Date.parse("2026-01-02T03:00:00.000Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

/** A rep as `runRep` records one. */
const rep = (over = {}) => ({
  arm: "A",
  task: "branch-scope",
  rep: 1,
  startedAt: iso(0),
  finishedAt: iso(30_000),
  wallMs: 30_000,
  success: false,
  score: 40,
  costUsd: 0.12,
  numTurns: 4,
  inputTokens: 900,
  outputTokens: 120,
  discarded: false,
  environmentFindings: [],
  ...over,
});

/** A `summarizeArm` block. */
const armBlock = (over = {}) => ({
  arm: "A",
  reps: 2,
  usableReps: 2,
  discardedReps: 0,
  costUsd: 0.24,
  successes: 0,
  successRate: 0,
  meanScore: 40,
  repeatedMistakes: 1,
  repeatedMistakeRate: 0.5,
  ...over,
});

const GOLDEN = {
  subcommand: "golden",
  runId: "2026-01-02T03-00-00-000Z",
  model: "claude-opus-5",
  costUsd: 0.48,
  caveat: "N=2 per arm is a low-power INDICATOR, not proof.",
  arms: [
    armBlock(),
    armBlock({
      arm: "B-canonical",
      successes: 2,
      successRate: 1,
      meanScore: 100,
      repeatedMistakeRate: 0,
    }),
  ],
  comparisons: [
    {
      arm: "B-canonical",
      baseline: "A",
      comparable: true,
      successRateLift: 1,
      meanScoreLift: 60,
      repeatedMistakeDelta: -0.5,
    },
  ],
  results: {
    A: [
      rep(),
      rep({ rep: 2, startedAt: iso(40_000), finishedAt: iso(70_000) }),
    ],
    "B-canonical": [
      rep({
        arm: "B-canonical",
        rep: 1,
        success: true,
        score: 100,
        startedAt: iso(80_000),
        finishedAt: iso(110_000),
      }),
    ],
  },
};

const points = (payload, name) => {
  const m = payload.resourceMetrics[0].scopeMetrics[0].metrics.find(
    (x) => x.name === name,
  );
  return m ? m.gauge.dataPoints : [];
};
const attrs = (node) =>
  Object.fromEntries(
    (node.attributes || []).map((a) => [
      a.key,
      a.value.stringValue ??
        a.value.doubleValue ??
        (a.value.intValue !== undefined
          ? Number(a.value.intValue)
          : a.value.boolValue),
    ]),
  );

test("every signal lands on the `eval` service, never on a product one", () => {
  // Two copies of the resource is how a metric ends up on a resource the
  // backend treats as a different service from the spans beside it — the
  // signals stop correlating and nothing errors.
  const traces = buildTracePayload(GOLDEN, T0);
  const metrics = buildMetricsPayload(GOLDEN, T0);
  for (const resource of [
    traces.payload.resourceSpans[0].resource,
    metrics.resourceMetrics[0].resource,
  ]) {
    const a = attrs(resource);
    assert.equal(a["service.name"], "eval");
    assert.equal(a["service.namespace"], "lorekit");
    // An eval is synthetic by construction and must never land in a production
    // view. The shared module hardcodes this; assert it from out here too,
    // because it is the property that makes the export safe to run in CI.
    assert.equal(a["deployment.environment.name"], "test");
  }
  assert.equal(SERVICE_NAME, "eval");
});

test("one root span, one child per rep, on the same trace", () => {
  const { payload, traceId } = buildTracePayload(GOLDEN, T0);
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 1 + 3);
  assert.ok(spans.every((s) => s.traceId === traceId));
  const [root, ...children] = spans;
  assert.equal(root.name, "lorekit.eval");
  assert.equal(root.parentSpanId, undefined);
  assert.ok(children.every((s) => s.parentSpanId === root.spanId));
  // The root covers the whole run: earliest start to latest finish.
  assert.equal(root.startTimeUnixNano, `${T0}000000`);
  assert.equal(root.endTimeUnixNano, `${T0 + 110_000}000000`);
});

test("a rep's span carries real timestamps, and says so when it cannot", () => {
  const real = buildTracePayload(GOLDEN, T0).payload.resourceSpans[0]
    .scopeSpans[0].spans[1];
  assert.equal(real.startTimeUnixNano, `${T0}000000`);
  assert.equal(real.endTimeUnixNano, `${T0 + 30_000}000000`);
  assert.equal(attrs(real)["lorekit.eval.timing"], undefined);

  // A summary written before reps carried timestamps still gets a span — but
  // the position is invented, and an unlabelled invented timestamp reads as
  // evidence about when the model ran.
  const legacy = {
    ...GOLDEN,
    results: { A: [{ arm: "A", task: "branch-scope", rep: 1, wallMs: 5_000 }] },
  };
  const span = buildTracePayload(legacy, T0).payload.resourceSpans[0]
    .scopeSpans[0].spans[1];
  assert.equal(attrs(span)["lorekit.eval.timing"], "synthetic");
  assert.equal(span.endTimeUnixNano, `${T0 + 5_000}000000`);
});

test("a DISCARDED rep is the error span, a failed one is not", () => {
  // Failing the task is the measurement working. Losing the rep to a
  // contaminated environment is the harness failing to measure anything.
  const failed = buildTracePayload(GOLDEN, T0).payload.resourceSpans[0]
    .scopeSpans[0].spans[1];
  assert.equal(failed.status.code, 1);
  assert.equal(attrs(failed)["lorekit.eval.success"], false);

  const dirty = {
    ...GOLDEN,
    results: {
      A: [
        rep({ discarded: true, environmentFindings: ["foreign-hooks-fired"] }),
      ],
    },
  };
  const spans = buildTracePayload(dirty, T0).payload.resourceSpans[0]
    .scopeSpans[0].spans;
  assert.equal(spans[1].status.code, 2);
  assert.match(spans[1].status.message, /foreign-hooks-fired/);
  // …and a run where EVERY rep was discarded produced no evidence at all,
  // which the root has to say or the trace reads as a completed experiment.
  assert.equal(spans[0].status.code, 2);
  assert.match(spans[0].status.message, /every rep was discarded/);
});

test("the root span carries the caveat verbatim, not a paraphrase", () => {
  // Whoever finds this trace months from now must meet the low-power caveat
  // without going back to the README.
  const root = buildTracePayload(GOLDEN, T0).payload.resourceSpans[0]
    .scopeSpans[0].spans[0];
  assert.equal(attrs(root)["lorekit.eval.caveat"], GOLDEN.caveat);
  assert.equal(attrs(root)["lorekit.eval.usable_reps"], 3);
  assert.equal(attrs(root)["lorekit.eval.discarded_reps"], 0);
});

test("a cell with zero usable reps emits no rate, never 0.0", () => {
  // 0.0 draws a flat line that reads as a failing arm. Absent reads as what it
  // is: nothing was measured.
  const empty = {
    ...GOLDEN,
    arms: [
      armBlock({
        arm: "A",
        reps: 2,
        usableReps: 0,
        discardedReps: 2,
        successRate: null,
        meanScore: null,
        costUsd: 0.24,
      }),
    ],
    comparisons: [],
    results: {
      A: [rep({ discarded: true }), rep({ rep: 2, discarded: true })],
    },
  };
  const payload = buildMetricsPayload(empty, T0);
  assert.equal(points(payload, "lorekit.eval.success_rate").length, 0);
  assert.equal(points(payload, "lorekit.eval.mean_score").length, 0);
  // The counts still land — "we ran two and lost both" is the finding.
  const counts = points(payload, "lorekit.eval.reps").map(attrs);
  assert.deepEqual(
    counts.map((a) => [a["lorekit.eval.rep_state"], a["lorekit.eval.arm"]]),
    [
      ["usable", "A"],
      ["discarded", "A"],
      ["ran", "A"],
    ],
  );
  // Cost is charged anyway: those reps were billed.
  assert.equal(points(payload, "lorekit.eval.cost")[0].asDouble, 0.24);
});

test("rates come from the summary's own aggregates, not recomputed here", () => {
  // The harness owns `summarizeArm`. An exporter with its own arithmetic would
  // keep publishing after the definition moved.
  const payload = buildMetricsPayload(GOLDEN, T0);
  const rates = points(payload, "lorekit.eval.success_rate");
  assert.deepEqual(
    rates.map((p) => [attrs(p)["lorekit.eval.arm"], p.asDouble]),
    [
      ["A", 0],
      ["B-canonical", 1],
    ],
  );
  // A 0 that the summary DID compute is published — the rule is about absence,
  // not about the value zero.
  assert.equal(rates[0].asDouble, 0);
});

test("golden's lift is published per measure, and only when comparable", () => {
  const lift = points(buildMetricsPayload(GOLDEN, T0), "lorekit.eval.lift").map(
    (p) => [attrs(p)["lorekit.eval.measure"], p.asDouble],
  );
  assert.deepEqual(lift, [
    ["success_rate", 1],
    ["mean_score", 60],
    ["repeated_mistake", -0.5],
  ]);

  const incomparable = {
    ...GOLDEN,
    comparisons: [
      {
        arm: "B-canonical",
        baseline: "A",
        comparable: false,
        successRateLift: null,
        meanScoreLift: null,
        repeatedMistakeDelta: null,
      },
    ],
  };
  assert.equal(
    points(buildMetricsPayload(incomparable, T0), "lorekit.eval.lift").length,
    0,
  );
});

test("variants publish net lift and the framing's token cost", () => {
  const VARIANTS = {
    subcommand: "variants",
    runId: "r",
    model: "claude-opus-5",
    cells: {
      "baseline-branch-scope": armBlock({ arm: "baseline-branch-scope" }),
      "rule-only-branch-scope": armBlock({
        arm: "rule-only-branch-scope",
        successRate: 1,
        meanScore: 100,
      }),
    },
    ranked: [
      {
        variant: "rule-only",
        comparable: true,
        onTargetLift: 1,
        offTargetDelta: -0.25,
        netLift: 0.75,
        tokensPerPoint: 1,
        estTokens: 58,
      },
    ],
    results: {
      "baseline-branch-scope": [rep({ variant: null })],
      "rule-only-branch-scope": [
        rep({ arm: "B-variant", variant: "rule-only", success: true }),
      ],
    },
  };
  const payload = buildMetricsPayload(VARIANTS, T0);
  const lift = points(payload, "lorekit.eval.lift").map((p) => [
    attrs(p)["lorekit.eval.variant"],
    attrs(p)["lorekit.eval.measure"],
    p.asDouble,
  ]);
  assert.deepEqual(lift, [
    ["rule-only", "on_target", 1],
    ["rule-only", "off_target", -0.25],
    ["rule-only", "net", 0.75],
  ]);
  assert.equal(points(payload, "lorekit.eval.tokens_per_point")[0].asDouble, 1);

  // Dimensions come from the REPS, because a cell id splits ambiguously —
  // both halves of `full-opaque-key-repo-scope` contain hyphens.
  const cells = cellAggregates(VARIANTS);
  const treatment = cells.find(
    (c) => c.cellId === "rule-only-branch-scope",
  ).dims;
  assert.equal(treatment["lorekit.eval.variant"], "rule-only");
  assert.equal(treatment["lorekit.eval.task"], "branch-scope");
  assert.equal(treatment["lorekit.eval.arm"], "B-variant");
  // …and golden's arms never acquire a `variant` dimension they do not have.
  assert.equal(
    cellDims([rep()])["lorekit.eval.variant"],
    undefined,
    "an absent variant is omitted, not stringified",
  );
});

test("all three `results` shapes flatten, and dry runs are dropped", () => {
  // arm0 writes an array, golden a map by arm, variants a map by cell id. A
  // shape silently unrecognised would look exactly like a run that emitted
  // nothing.
  assert.equal(flattenReps(GOLDEN).length, 3);
  assert.equal(flattenReps({ results: [rep(), rep({ rep: 2 })] }).length, 2);
  assert.deepEqual(flattenReps({ results: [{ dryRun: true }] }), []);
  assert.deepEqual(flattenReps({}), []);
  assert.deepEqual(flattenReps(null), []);
  // arm0 publishes no aggregate block, so it contributes spans and no rates
  // rather than an aggregate this file would have had to invent.
  const arm0 = { subcommand: "arm0", results: [rep()] };
  assert.deepEqual(cellAggregates(arm0), []);
  assert.equal(
    points(buildMetricsPayload(arm0, T0), "lorekit.eval.reps").length,
    0,
  );
  assert.equal(
    buildTracePayload(arm0, T0).payload.resourceSpans[0].scopeSpans[0].spans
      .length,
    2,
  );
});

test("timestamps are never NaN, whatever the summary holds", () => {
  // `toUnixNano(NaN)` reaches OTLP as the string "NaN000000" and the whole
  // payload is rejected with a 400 that names nothing.
  const junk = {
    results: { A: [{ arm: "A", startedAt: "not-a-date", wallMs: "also-not" }] },
  };
  const spans = buildTracePayload(junk, T0).payload.resourceSpans[0]
    .scopeSpans[0].spans;
  for (const s of spans) {
    assert.match(s.startTimeUnixNano, /^\d+$/);
    assert.match(s.endTimeUnixNano, /^\d+$/);
  }
});

test("a dry run builds the payload without resolving a credential", async () => {
  // Which is exactly when you most want to see what would have been sent.
  const result = await exportEval({ summary: GOLDEN, dryRun: true }, {});
  assert.equal(result.exported, false);
  assert.equal(result.dryRun, true);
  assert.ok(result.traces.resourceSpans);
  assert.ok(result.metrics.resourceMetrics);
});

test("no endpoint or an opt-out is a stated reason, never a throw", async () => {
  // A failed export must not retroactively fail an experiment that already
  // produced its result.
  const optedOut = await exportEval(
    { summary: GOLDEN },
    { LOREKIT_TELEMETRY: "0" },
  );
  assert.equal(optedOut.exported, false);
  assert.equal(optedOut.reason, "opted-out");
});

test("resolveSummaryPath finds the file, the run dir, or the newest run", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "eval-tel-"));
  try {
    assert.equal(resolveSummaryPath(path.join(root, "nope")), null);
    // An --out parent with no runs in it yet.
    assert.equal(resolveSummaryPath(root), null);

    const older = path.join(root, "golden-2026-01-01T00-00-00-000Z");
    const newer = path.join(root, "golden-2026-02-01T00-00-00-000Z");
    for (const dir of [older, newer]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "summary.json"), "{}");
    }
    // A run id sorts by its ISO timestamp, so the last is the newest.
    assert.equal(resolveSummaryPath(root), path.join(newer, "summary.json"));
    assert.equal(resolveSummaryPath(newer), path.join(newer, "summary.json"));
    assert.equal(
      resolveSummaryPath(path.join(newer, "summary.json")),
      path.join(newer, "summary.json"),
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
