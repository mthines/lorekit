// The lesson-variant axis, checked without a sandbox, a store or a model.
//
// Two families of assertion live here and they guard different failures. The
// LADDER assertions keep the variants an ablation of one fact — the moment a
// row knows something the others do not, the experiment stops measuring
// framing. The SCORING assertions keep the net-value arithmetic from saying
// more than the run measured, which is the number most likely to be quoted out
// of an artifact months later.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHARS_PER_TOKEN,
  INGREDIENTS,
  LESSON_VARIANTS,
  OPAQUE_KEY,
  SHARED_KEY,
  VARIANT_IDS,
  describeVariant,
  estimateTokens,
  rankVariants,
  renderAllVariants,
  renderVariant,
  scoreVariant,
  summarizeCell,
  variantById,
} from "../../src/harness/variants.mjs";
import {
  OFF_TARGET_SCOPE,
  TARGET_SCOPE,
  taskById,
} from "../../src/harness/task.mjs";

const cell = (usableReps, successRate) => ({
  usableReps,
  successRate,
  meanScore: successRate === null ? null : successRate * 100,
});

test("every variant id is unique and resolvable", () => {
  assert.equal(new Set(VARIANT_IDS).size, VARIANT_IDS.length);
  for (const id of VARIANT_IDS) assert.equal(variantById(id).id, id);
  assert.throws(() => variantById("nope"), /unknown variant/);
});

test("no variant quotes a graded target — that would measure copying", () => {
  // The single failure that would make this whole axis report a large,
  // meaningless lift: a lesson containing the exact string the grader
  // exact-matches on. Asserted of the RENDERED body and key, so a future edit
  // to the ingredient texts cannot reintroduce it quietly.
  for (const v of renderAllVariants()) {
    const text = `${v.key}\n${v.body}`;
    assert.doesNotMatch(text, /mthines\/gw-tools/, `variant ${v.id}`);
    assert.ok(
      !text.includes(TARGET_SCOPE),
      `variant ${v.id} quotes the target`,
    );
    assert.ok(!text.includes(OFF_TARGET_SCOPE), `variant ${v.id}`);
  }
});

test("every variant states the rule it is a framing of", () => {
  // The ladder is an ablation, so each row must still carry the fact. A row
  // that dropped it would score badly for the uninteresting reason.
  for (const v of renderAllVariants()) {
    assert.match(v.body, /::/, `variant ${v.id} never shows the separator`);
    assert.match(v.body, /branch/i, `variant ${v.id}`);
  }
});

test("every variant declares which question it asks", () => {
  // A row whose question is not written down is a row nobody can interpret.
  for (const v of LESSON_VARIANTS) {
    assert.equal(typeof v.asks, "string");
    assert.ok(v.asks.trim().length > 10, `variant ${v.id}`);
    assert.match(v.asks, /\?$/, `variant ${v.id}`);
  }
});

test("the key is held constant except in the one variant that varies it", () => {
  // Otherwise the key's effect is smeared across every row instead of being
  // separable, which is the whole reason it gets a dedicated variant.
  const varied = LESSON_VARIANTS.filter((v) => v.key !== SHARED_KEY);
  assert.equal(varied.length, 1);
  assert.equal(varied[0].id, "full-opaque-key");
  assert.equal(varied[0].key, OPAQUE_KEY);
  // And it must differ ONLY in the key: same body as `full`.
  assert.equal(
    renderVariant("full-opaque-key").body,
    renderVariant("full").body,
  );
});

test("the ladder actually ablates — reduced rows are strict subsets", () => {
  const of = (id) => new Set(variantById(id).ingredients);
  const full = of("full");
  for (const id of [
    "rule-only",
    "rule-example",
    "rule-antiexample",
    "untriggered",
  ]) {
    for (const ingredient of of(id)) {
      assert.ok(
        full.has(ingredient),
        `${id} carries ${ingredient}, full does not`,
      );
    }
    assert.ok(of(id).size < full.size, `${id} is not a reduction of full`);
  }
  assert.deepEqual([...full].sort(), [...INGREDIENTS].sort());
});

test("padded differs from full in length alone, not in content", () => {
  const full = renderVariant("full");
  const padded = renderVariant("padded");
  assert.ok(
    padded.body.startsWith(full.body),
    "padded is not full plus filler",
  );
  // Roughly 3x. A lesson padded by half again would move nothing, so a shrunken
  // filler would leave a row that reads as a dilution test and is not one.
  assert.ok(
    padded.estTokens > full.estTokens * 2.5,
    `padded is only ${(padded.estTokens / full.estTokens).toFixed(2)}x full`,
  );
  // The filler must not touch scope syntax, or `padded` stops being an
  // ablation of length and becomes one of content.
  const filler = padded.body.slice(full.body.length);
  assert.doesNotMatch(filler, /scope|::|separator/i);
});

test("cost is the estimate the product's own cost line uses", () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  // Total, never NaN, never negative — it is divided by downstream.
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  const v = renderVariant("rule-only");
  assert.equal(v.estTokens, estimateTokens(v.key) + estimateTokens(v.body));
});

test("the off-target task is a real, runnable neighbour of the on-target one", () => {
  const on = taskById("branch-scope");
  const off = taskById("repo-scope");
  assert.equal(on.role, "on-target");
  assert.equal(off.role, "off-target");
  // Same repository, one granularity coarser — that adjacency is what makes it
  // a probe for OVER-APPLICATION rather than for irrelevance.
  assert.ok(TARGET_SCOPE.startsWith(`branch::`));
  assert.equal(OFF_TARGET_SCOPE, `repo::${TARGET_SCOPE.split("::")[1]}`);
  // And the prompts differ in what they ask for, not in how they ask.
  assert.match(off.prompt(), /memory\.write/);
  assert.match(off.prompt(), /not to any one branch/);
  assert.match(off.prompt(), /reply with the scope string/);
});

test("a variant with an unmeasured cell is not comparable and carries no lift", () => {
  const scored = scoreVariant({
    variant: renderVariant("full"),
    onTarget: cell(3, 1),
    offTarget: cell(0, null),
    baselineOnTarget: cell(3, 0),
    baselineOffTarget: cell(3, 1),
  });
  assert.equal(scored.comparable, false);
  // The flattering half must NOT be published on its own.
  assert.equal(scored.netLift, null);
  assert.equal(scored.offTargetDelta, null);
  assert.match(describeVariant(scored), /not comparable/);
});

test("off-target downside is charged in full; upside is not credited", () => {
  const base = {
    variant: renderVariant("full"),
    onTarget: cell(3, 1),
    baselineOnTarget: cell(3, 1 / 3),
    baselineOffTarget: cell(3, 2 / 3),
  };
  const hurt = scoreVariant({ ...base, offTarget: cell(3, 1 / 3) });
  assert.ok(Math.abs(hurt.onTargetLift - 2 / 3) < 1e-9);
  assert.ok(Math.abs(hurt.offTargetDelta - -1 / 3) < 1e-9);
  assert.ok(Math.abs(hurt.netLift - 1 / 3) < 1e-9);

  const helped = scoreVariant({ ...base, offTarget: cell(3, 1) });
  assert.ok(helped.offTargetDelta > 0);
  // Credited at zero: an apparent gain on a task the lesson is not about is
  // noise far more often than transfer, and the score is biased against the
  // lesson on purpose.
  assert.ok(Math.abs(helped.netLift - helped.onTargetLift) < 1e-9);
});

test("skipping the off-target task withholds the net number, and says so", () => {
  const scored = scoreVariant({
    variant: renderVariant("full"),
    onTarget: cell(3, 1),
    baselineOnTarget: cell(3, 0),
  });
  // Comparable — the on-target half really was measured…
  assert.equal(scored.comparable, true);
  assert.equal(scored.onTargetLift, 1);
  // …but the net value is not inferable from it, and must not be reported.
  assert.equal(scored.netLift, null);
  assert.equal(scored.offTargetRun, false);
  assert.match(describeVariant(scored), /off-target not run/);
  assert.match(describeVariant(scored), /net value unknown/);
});

test("cost per point is withheld unless there was a gain to price", () => {
  const flat = scoreVariant({
    variant: renderVariant("full"),
    onTarget: cell(3, 0),
    offTarget: cell(3, 1),
    baselineOnTarget: cell(3, 0),
    baselineOffTarget: cell(3, 1),
  });
  assert.equal(flat.netLift, 0);
  // Never Infinity, and never a flattering negative.
  assert.equal(flat.tokensPerPoint, null);

  const gained = scoreVariant({
    variant: renderVariant("rule-only"),
    onTarget: cell(4, 1),
    offTarget: cell(4, 1),
    baselineOnTarget: cell(4, 0.5),
    baselineOffTarget: cell(4, 1),
  });
  assert.ok(gained.tokensPerPoint > 0);
  assert.equal(
    gained.tokensPerPoint,
    Math.round(renderVariant("rule-only").estTokens / 50),
  );
});

test("ranking never places an unmeasured variant above a measured one", () => {
  const measured = (id, net) => ({
    variant: id,
    comparable: true,
    netLift: net,
    estTokens: 100,
  });
  const ranked = rankVariants([
    { variant: "broken", comparable: false, netLift: null, estTokens: 10 },
    measured("small", 0.1),
    measured("big", 0.9),
  ]);
  assert.deepEqual(
    ranked.map((r) => [r.variant, r.rank]),
    [
      ["big", 1],
      ["small", 2],
      // Not "worst" — unranked. The run has no evidence for a position.
      ["broken", null],
    ],
  );
});

test("a tie breaks toward the cheaper framing", () => {
  const ranked = rankVariants([
    { variant: "verbose", comparable: true, netLift: 0.5, estTokens: 400 },
    { variant: "terse", comparable: true, netLift: 0.5, estTokens: 40 },
  ]);
  assert.deepEqual(
    ranked.map((r) => r.variant),
    ["terse", "verbose"],
  );
});

test("a description carries its Ns and refuses significance", () => {
  const scored = scoreVariant({
    variant: renderVariant("full"),
    onTarget: cell(3, 1),
    offTarget: cell(3, 1),
    baselineOnTarget: cell(3, 0),
    baselineOffTarget: cell(3, 1),
  });
  const text = describeVariant(scored);
  assert.match(text, /usable reps/);
  assert.match(text, /INDICATOR/);
  assert.match(text, /not a significance claim/);
  assert.doesNotMatch(
    text,
    /\bp\s*[<=]|\bconfidence interval\b|\bsignificant\b/i,
  );
});

test("a cell is summarized by the SAME code a golden arm is", () => {
  // Rates from the two experiments get read side by side, so `usableReps` and
  // the discard rules have to mean one thing, not two.
  const summary = summarizeCell("full-branch-scope", [
    { success: true, score: 100 },
    { success: false, score: 20 },
    { success: false, score: 0, discarded: true },
  ]);
  assert.equal(summary.arm, "full-branch-scope");
  assert.equal(summary.usableReps, 2);
  assert.equal(summary.successRate, 0.5);
});
