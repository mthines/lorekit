// The golden experiment's pure core.
//
// Every assertion here runs with no sandbox, no store and no model, because the
// comparison is the part of the harness most likely to be READ OUT OF CONTEXT —
// a lift quoted from an artifact months later — and the guards that stop it
// saying more than it knows must therefore be the cheapest thing to check.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ARM_0,
  ARM_A,
  ARM_B_CANONICAL,
  ARM_B_ORGANIC,
  ARM_C,
  BASELINE_ARM,
  GOLDEN_ARMS,
  armById,
  armCPrompt,
  armPlan,
  compareArms,
  describeComparison,
  isUsable,
  resolveArmSelection,
  summarizeArm,
  transcriptDigest,
} from "../../src/harness/golden.mjs";
import { RETRIEVAL_ABSENT } from "../../src/grading/retrieval.mjs";

const clean = (over = {}) => ({
  success: false,
  score: 0,
  repeatedMistake: false,
  discarded: false,
  ...over,
});

test("arm A is the baseline and is never itself a treatment", () => {
  assert.equal(BASELINE_ARM, ARM_A);
  assert.equal(armById(ARM_A).isBaseline, true);
  assert.equal(armById(ARM_A).isTreatment, false);
  // Arm 0 produces the material the other arms need; comparing it to the
  // control would compare a first attempt with a retry.
  assert.equal(armById(ARM_0).isTreatment, false);
});

test("every arm id is unique and resolvable", () => {
  const ids = GOLDEN_ARMS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(armById(id).id, id);
  assert.throws(() => armById("nope"), /unknown arm/);
});

test("arm A and arm B differ ONLY in the store", () => {
  const a = armById(ARM_A);
  const b = armById(ARM_B_CANONICAL);
  assert.notEqual(a.seed, b.seed);
  // The whole experimental control: everything else about the two arms is the
  // same, so a difference in outcome has one candidate explanation.
  assert.equal(a.allowWrite, b.allowWrite);
});

test("only arm 0 may write — a retry cannot contaminate its own store", () => {
  for (const arm of GOLDEN_ARMS) {
    assert.equal(arm.allowWrite, arm.id === ARM_0, `arm ${arm.id}`);
  }
});

test("B-organic is SKIPPED with a reason, never silently canonical", () => {
  const { run, skipped } = armPlan({ priorTranscript: true });
  assert.ok(!run.some((a) => a.id === ARM_B_ORGANIC));
  const reason = skipped.find((s) => s.id === ARM_B_ORGANIC);
  assert.match(reason.reason, /--lesson-file/);
  // The canonical arm still runs; it is simply not relabelled.
  assert.ok(run.some((a) => a.id === ARM_B_CANONICAL));
});

test("arm C is skipped when arm 0 produced no transcript", () => {
  const { run, skipped } = armPlan({ organicLesson: true });
  assert.ok(!run.some((a) => a.id === ARM_C));
  assert.match(skipped.find((s) => s.id === ARM_C).reason, /no transcript/);
});

test("with everything available, all five arms run", () => {
  const { run, skipped } = armPlan({
    organicLesson: true,
    priorTranscript: true,
  });
  assert.equal(run.length, GOLDEN_ARMS.length);
  assert.deepEqual(skipped, []);
});

test("an empty --arm list is every arm, and a list is a NARROWING", () => {
  assert.deepEqual(
    resolveArmSelection([]),
    GOLDEN_ARMS.map((a) => a.id),
  );
  assert.deepEqual(
    resolveArmSelection(),
    GOLDEN_ARMS.map((a) => a.id),
  );
  assert.deepEqual(resolveArmSelection([ARM_A, ARM_B_CANONICAL]), [
    ARM_A,
    ARM_B_CANONICAL,
  ]);
});

test("--arm returns CANONICAL order, not the order they were typed", () => {
  // Arm 0 has to run first — it is the source of arm C's material — so the
  // selection cannot be allowed to hand back a list that puts it last.
  assert.deepEqual(resolveArmSelection([ARM_C, ARM_A, ARM_0]), [
    ARM_0,
    ARM_A,
    ARM_C,
  ]);
  // Repeats collapse: a doubled id would otherwise run the arm twice, paying
  // twice for one cell, exactly as a repeated --variant once did.
  assert.deepEqual(resolveArmSelection([ARM_A, ARM_A]), [ARM_A]);
});

test("--arm refuses an unknown id rather than running a smaller experiment", () => {
  assert.throws(() => resolveArmSelection(["B-cannonical"]), /unknown arm/);
});

test("--arm C without arm 0 is refused, and the message says what to type", () => {
  // Arm C re-reads arm 0's transcript. Left to armPlan this is skipped for
  // "arm 0 produced no transcript" — accurate, and useless as guidance.
  assert.throws(() => resolveArmSelection([ARM_C]), /Add --arm 0/);
  assert.doesNotThrow(() => resolveArmSelection([ARM_0, ARM_C]));
});

test("an unselected arm is skipped for NOT BEING SELECTED, not for a missing dep", () => {
  const { run, skipped } = armPlan({
    organicLesson: true,
    priorTranscript: false,
    selected: [ARM_A, ARM_B_CANONICAL],
  });
  assert.deepEqual(
    run.map((a) => a.id),
    [ARM_A, ARM_B_CANONICAL],
  );
  const c = skipped.find((s) => s.id === ARM_C);
  assert.match(c.reason, /not selected/);
  // The dependency reason would be TRUE here too — arm 0 was not run, so
  // there is no transcript — and reporting it would read as a fault in a run
  // that did exactly what it was asked.
  assert.doesNotMatch(c.reason, /no transcript/);
});

test("a --arm subset that omits the baseline reports NO lift, and says why", () => {
  // The rule that makes cheap subsetting safe. It is structural — the control
  // is simply absent from `summaries` — but the REASON has to distinguish
  // this from a baseline that ran and was entirely discarded, because the two
  // ask the reader for different things.
  const [b] = compareArms([
    summarizeArm(ARM_B_CANONICAL, [clean({ success: true, score: 100 })]),
  ]);
  assert.equal(b.comparable, false);
  assert.equal(b.successRateLift, null);
  assert.equal(b.meanScoreLift, null);
  assert.equal(b.repeatedMistakeDelta, null);
  assert.match(b.reason, /baseline arm A did not run/);
  assert.match(describeComparison(b), /Add --arm A/);
  // And it must NOT claim the reps were unusable — they were fine.
  assert.doesNotMatch(b.reason, /usable reps/);
});

test("a contaminated or harness-fault rep is not usable", () => {
  assert.equal(isUsable(clean()), true);
  assert.equal(isUsable(clean({ discarded: true })), false);
  assert.equal(isUsable({ dryRun: true }), false);
  assert.equal(
    isUsable(clean({ retrieval: { state: RETRIEVAL_ABSENT } })),
    false,
  );
});

test("rates are computed over usableReps, not reps", () => {
  const s = summarizeArm(ARM_A, [
    clean({ success: true, score: 100 }),
    clean({ success: false, score: 0 }),
    // Discarded: must not drag the rate down as though it were a failure.
    clean({ success: false, score: 0, discarded: true }),
  ]);
  assert.equal(s.reps, 3);
  assert.equal(s.usableReps, 2);
  assert.equal(s.discardedReps, 1);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.meanScore, 50);
});

test("attribution is null for an unseeded arm", () => {
  // Arm A's empty store is the point; reporting its failures as retrieval
  // faults would blame the harness for the control behaving as designed.
  assert.equal(summarizeArm(ARM_A, [clean()]).attribution, null);
});

test("a seeded arm splits failures into utilization vs retrieval", () => {
  const s = summarizeArm(ARM_B_CANONICAL, [
    clean({ retrieval: { state: "injected", injected: true } }),
    clean({ retrieval: { state: "in-store-not-loaded", injected: false } }),
    clean({ success: true, retrieval: { state: "injected", injected: true } }),
  ]);
  assert.equal(s.usableReps, 3);
  assert.equal(s.attribution.utilization, 1);
  assert.equal(s.attribution.retrieval, 1);
  assert.equal(s.injectedReps, 2);
});

test("a lift is refused when either arm has no usable reps", () => {
  const comparisons = compareArms([
    summarizeArm(ARM_A, [clean({ discarded: true })]),
    summarizeArm(ARM_B_CANONICAL, [clean({ success: true })]),
  ]);
  const b = comparisons.find((c) => c.arm === ARM_B_CANONICAL);
  assert.equal(b.comparable, false);
  // Not 0, and not a number at all — a zero here reads as "memory made no
  // difference", which is the opposite of "we could not measure".
  assert.equal(b.successRateLift, null);
  assert.match(describeComparison(b), /not comparable/);
});

test("a real lift is a plain difference in rates", () => {
  const comparisons = compareArms([
    summarizeArm(ARM_A, [
      clean({ success: false, score: 20 }),
      clean({ success: false, score: 20 }),
    ]),
    summarizeArm(ARM_B_CANONICAL, [
      clean({ success: true, score: 100 }),
      clean({ success: false, score: 20 }),
    ]),
  ]);
  const b = comparisons.find((c) => c.arm === ARM_B_CANONICAL);
  assert.equal(b.comparable, true);
  assert.equal(b.successRateLift, 0.5);
  assert.equal(b.meanScoreLift, 40);
});

test("the baseline arm never compares against itself", () => {
  const comparisons = compareArms([
    summarizeArm(ARM_A, [clean()]),
    summarizeArm(ARM_0, [clean()]),
  ]);
  assert.deepEqual(comparisons, []);
});

test("a described comparison always carries its N and refuses significance", () => {
  const [b] = compareArms([
    summarizeArm(ARM_A, [clean()]),
    summarizeArm(ARM_B_CANONICAL, [clean({ success: true })]),
  ]);
  const text = describeComparison(b);
  assert.match(text, /usable reps/);
  assert.match(text, /INDICATOR/);
  // Significance is DISCLAIMED, never asserted, and no statistic is implied.
  assert.match(text, /not a significance claim/);
  assert.doesNotMatch(
    text,
    /\bp\s*[<=]|\bconfidence interval\b|\bsignificant\b/i,
  );
});

test("transcriptDigest keeps the agent's words and its tool calls", () => {
  const jsonl = [
    JSON.stringify({
      message: { content: [{ type: "text", text: "I will write it." }] },
    }),
    "{ not json",
    JSON.stringify({
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__lorekit__memory_write",
            input: { scope: "branch:mthines/gw-tools" },
          },
        ],
      },
    }),
  ].join("\n");
  const digest = transcriptDigest(jsonl);
  assert.match(digest, /I will write it\./);
  // The wrong scope is exactly what arm C is meant to be able to re-read.
  assert.match(digest, /branch:mthines\/gw-tools/);
});

test("transcriptDigest is total and bounded", () => {
  assert.equal(transcriptDigest(""), "");
  assert.equal(transcriptDigest(null), "");
  const long = JSON.stringify({
    message: { content: [{ type: "text", text: "x".repeat(9000) }] },
  });
  assert.ok(transcriptDigest(long, { maxChars: 100 }).length < 200);
});

test("arm C asks the SAME question, only with more material", () => {
  const prompt = armCPrompt("Record a lesson.", "prior attempt text");
  assert.match(prompt, /prior attempt text/);
  // The task statement must survive verbatim, or the arms stop being comparable.
  assert.match(prompt, /Record a lesson\./);
  assert.throws(() => armCPrompt("Record a lesson.", "  "), /non-empty/);
});
