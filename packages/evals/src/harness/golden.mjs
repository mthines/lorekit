// The golden experiment: arms 0 / A / B / C, and the comparison between them.
//
// `arm0` answers "can the agent do this cold?". It cannot answer the question
// the package exists for — **does a stored, loaded lesson make the agent do
// better work?** — because that question is a DIFFERENCE between two arms, and
// nothing here ran the second one. This module is that difference.
//
// Everything in this file is PURE. The arm descriptors, the aggregation and the
// comparison take plain records and return plain records, so the whole rubric is
// testable against hand-written arm results with no sandbox, no store and no
// model — the same discipline `grade.mjs` follows, and for the same reason: the
// live path is slow, costly and flaky, so anything that CAN be decided without
// it must be.
//
// WHAT THE COMPARISON MAY AND MAY NOT SAY.
// N is tiny and the arms are stochastic. This module therefore reports a
// DIFFERENCE IN RATES and refuses to dress it up: there is no p-value, no
// confidence interval and no use of the word "significant" anywhere in it. A
// comparison whose either side has no usable reps is marked `comparable: false`
// and carries no lift at all, rather than a lift computed against zero.
import { RETRIEVAL_ABSENT, attributeFailure } from "../grading/retrieval.mjs";

/** Arm identifiers. Strings, not indices — they appear in artifacts. */
export const ARM_0 = "0";
export const ARM_A = "A";
export const ARM_B_ORGANIC = "B-organic";
export const ARM_B_CANONICAL = "B-canonical";
export const ARM_C = "C";

/** The arm every treatment is measured AGAINST. */
export const BASELINE_ARM = ARM_A;

/**
 * The arms, as data.
 *
 * `seed`, `allowWrite` and `needs` are the only things that vary; everything
 * else about an arm's world is assembled by `prepareArm`, which is what keeps
 * arm A and arm B from drifting apart in some detail nobody is watching.
 *
 * THE HOOK IS INSTALLED IN EVERY ARM, INCLUDING ARM 0. The design table in the
 * README describes arm 0 with the hook off, and against an EMPTY store the two
 * are indistinguishable — the hook has nothing to inject either way. Leaving it
 * installed everywhere is the stronger control: arm 0 and arm A then differ in
 * exactly one bit (whether writes are allowed), rather than in two.
 */
export const GOLDEN_ARMS = [
  {
    id: ARM_0,
    seed: "empty",
    allowWrite: true,
    isBaseline: false,
    isTreatment: false,
    needs: null,
    what: "The first attempt, and the source of the organic lesson.",
  },
  {
    id: ARM_A,
    seed: "empty",
    allowWrite: false,
    isBaseline: true,
    isTreatment: false,
    needs: null,
    what: "The retry with no memory — the control.",
  },
  {
    id: ARM_B_ORGANIC,
    seed: "organic",
    allowWrite: false,
    isBaseline: false,
    isTreatment: true,
    // Supplied by the operator (`--lesson-file`), never fabricated. See
    // `armPlan` for why this arm is SKIPPED rather than substituted.
    needs: "organic-lesson",
    what: "The retry with the lesson the loop would really have saved.",
  },
  {
    id: ARM_B_CANONICAL,
    seed: "canonical",
    allowWrite: false,
    isBaseline: false,
    isTreatment: true,
    needs: null,
    what: "The retry with a curated gold lesson. The only difference from A.",
  },
  {
    id: ARM_C,
    seed: "empty",
    allowWrite: false,
    isBaseline: false,
    isTreatment: true,
    // Arm C needs arm 0 to have produced a transcript to paste back.
    needs: "prior-transcript",
    what: "Diagnostic: does the lesson beat just re-reading the transcript?",
  },
];

/** Look up an arm descriptor by id. */
export function armById(id) {
  const arm = GOLDEN_ARMS.find((a) => a.id === id);
  if (!arm) {
    throw new Error(
      `unknown arm "${id}"; known: ${GOLDEN_ARMS.map((a) => a.id).join(", ")}`,
    );
  }
  return arm;
}

/**
 * Resolve an operator-supplied `--arm` list into the arms this run will cover.
 *
 * Empty (or absent) means EVERY arm — an explicit list is a NARROWING, so
 * "asked for none" and "asked for all" never have to be told apart by a
 * sentinel. That is the same shape `--variant` already has for the variants
 * experiment, deliberately: the two cost dials should not need different
 * mental models.
 *
 * Two rules are enforced here, before anything is spent, rather than
 * discovered from an artifact afterwards:
 *
 *   - an unknown id is REFUSED, because the alternative is a typo quietly
 *     running three arms instead of four and the missing arm reading as a
 *     result about memory;
 *   - selecting arm C without arm 0 is REFUSED, because arm C's entire
 *     construction is re-reading ARM 0's transcript. Left to `armPlan` it
 *     would be skipped for "arm 0 produced no transcript" — true, and no help
 *     at all in working out what to type instead.
 *
 * Arm A is deliberately NOT forced into the selection. A run without the
 * baseline is a legitimate thing to want ("just score the seeded arm"), and
 * its honest consequence is that the run carries no lift — which `compareArms`
 * states per comparison, naming the absent baseline. Forcing arm A in would
 * silently double the cheapest run's cost to protect a number the operator did
 * not ask for.
 *
 * @param {string[]} [ids]  the ids the operator asked for; empty means all
 * @returns {string[]} the selected ids, in canonical arm order
 */
export function resolveArmSelection(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return GOLDEN_ARMS.map((a) => a.id);
  }
  const asked = new Set(ids);
  for (const id of asked) armById(id); // refuses an unknown id
  if (asked.has(ARM_C) && !asked.has(ARM_0)) {
    throw new Error(
      `arm ${ARM_C} re-reads arm ${ARM_0}'s transcript, so it cannot run ` +
        `without it. Add --arm ${ARM_0}.`,
    );
  }
  // Canonical order, never the order they were typed: arm 0 has to run first
  // because it is the source of arm C's material, and an artifact read months
  // later should list its arms the same way every time.
  return GOLDEN_ARMS.filter((a) => asked.has(a.id)).map((a) => a.id);
}

/**
 * Decide which arms can actually run, and record WHY each excluded one cannot.
 *
 * An arm that cannot run is dropped with a stated reason rather than quietly
 * substituted with something else. Substituting is the tempting failure here:
 * running B-canonical and labelling it B-organic would report a curated lesson's
 * result as if it were the loop's own wording, which is the one thing that
 * source exists to measure.
 *
 * An arm the operator did not SELECT is dropped through the same channel, for
 * the same reason: a cheap subset run and a run whose organic lesson was
 * missing must be told apart by reading the artifact, not by remembering which
 * flags were typed.
 *
 * @param {object}  [available]
 * @param {boolean} [available.organicLesson]  an operator-supplied lesson exists
 * @param {boolean} [available.priorTranscript] arm 0 produced a transcript
 * @param {string[]|null} [available.selected]  `--arm` narrowing; null = all
 * @returns {{ run: object[], skipped: {id: string, reason: string}[] }}
 */
export function armPlan({
  organicLesson = false,
  priorTranscript = false,
  selected = null,
} = {}) {
  const chosen = selected === null ? null : new Set(selected);
  const have = {
    "organic-lesson": Boolean(organicLesson),
    "prior-transcript": Boolean(priorTranscript),
  };
  const reasons = {
    "organic-lesson":
      "no organic lesson supplied — pass --lesson-file <path> with the lesson " +
      "the loop would have saved after arm 0. It is never auto-substituted " +
      "with the canonical one, which would report a curated lesson as the " +
      "agent's own wording.",
    "prior-transcript":
      "arm 0 produced no transcript to paste back, so there is nothing for " +
      "this arm to re-read.",
  };

  const run = [];
  const skipped = [];
  for (const arm of GOLDEN_ARMS) {
    // Selection is checked FIRST. An arm the operator excluded is skipped for
    // that reason and not for a dependency it was never going to have — arm C
    // dropped from a `--arm 0 A` run is "not selected", never "arm 0 produced
    // no transcript", which would read as a fault in a run that behaved.
    if (chosen && !chosen.has(arm.id)) {
      skipped.push({
        id: arm.id,
        reason:
          `not selected — this run asked for ` +
          `${[...chosen].join(", ")} via --arm.`,
      });
      continue;
    }
    if (arm.needs && !have[arm.needs]) {
      skipped.push({ id: arm.id, reason: reasons[arm.needs] });
      continue;
    }
    run.push(arm);
  }
  return { run, skipped };
}

/**
 * Render a stream-json transcript as something worth pasting into arm C's
 * prompt: the assistant's own words and the tool calls it made.
 *
 * Raw JSONL would work but spends most of its tokens on envelope fields the
 * agent has no use for, and arm C is meant to test whether RE-READING THE
 * ATTEMPT is as good as a lesson — not whether the model can parse a log.
 *
 * Total, like `attemptedScopesFromTranscript`: malformed lines are skipped.
 */
export function transcriptDigest(transcriptText, { maxChars = 6000 } = {}) {
  if (typeof transcriptText !== "string" || transcriptText === "") return "";
  const lines = [];
  for (const raw of transcriptText.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content =
      entry && entry.message && Array.isArray(entry.message.content)
        ? entry.message.content
        : null;
    if (!content) continue;
    for (const item of content) {
      if (!item) continue;
      if (item.type === "text" && typeof item.text === "string") {
        const text = item.text.trim();
        if (text) lines.push(text);
      } else if (item.type === "tool_use" && typeof item.name === "string") {
        lines.push(
          `[called ${item.name} with ${JSON.stringify(item.input ?? {})}]`,
        );
      }
    }
  }
  const joined = lines.join("\n");
  return joined.length > maxChars
    ? `${joined.slice(0, maxChars)}\n…[truncated]`
    : joined;
}

/**
 * Arm C's prompt: the task, plus the earlier attempt to re-read.
 *
 * The task statement is IDENTICAL to every other arm's — arm C differs from arm
 * A in what it is given, never in what it is asked. Changing the ask would make
 * the arms incomparable, which is the whole point of assembling them in one
 * place.
 */
export function armCPrompt(taskPrompt, digest) {
  if (typeof taskPrompt !== "string" || taskPrompt === "") {
    throw new TypeError("armCPrompt: taskPrompt must be a non-empty string");
  }
  if (typeof digest !== "string" || digest.trim() === "") {
    throw new TypeError(
      "armCPrompt: a non-empty transcript digest is required",
    );
  }
  return [
    "Here is a transcript of an earlier attempt at this same task:",
    "",
    "<previous-attempt>",
    digest,
    "</previous-attempt>",
    "",
    "Now do the task yourself:",
    "",
    taskPrompt,
  ].join("\n");
}

/** A rep counts toward N only when it ran, stayed clean, and was not a fault. */
export function isUsable(rep) {
  if (!rep || rep.dryRun) return false;
  if (rep.discarded) return false;
  if (rep.retrieval && rep.retrieval.state === RETRIEVAL_ABSENT) return false;
  return true;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Aggregate one arm's reps.
 *
 * `usableReps` — not `reps` — is the only N any conclusion may cite, and every
 * rate below is computed over it. A contaminated rep (the developer's skills
 * loaded) and a harness fault (the arm was supposed to be seeded and was not)
 * are both DISCARDED rather than counted as failures, because counting them
 * would let a wiring regression read as evidence that memory does not work.
 */
export function summarizeArm(armId, reps = []) {
  const all = reps.filter((r) => r && !r.dryRun);
  const usable = all.filter(isUsable);
  const successes = usable.filter((r) => r.success).length;
  const scored = usable.filter((r) => typeof r.score === "number");
  const failures = usable.filter((r) => !r.success);

  // Attribution only means something for an arm that was SEEDED: a failure in
  // arm A is the baseline behaving as expected, not a retrieval fault.
  const seeded = usable.some((r) => r.retrieval);
  const attribution = { utilization: 0, retrieval: 0, unknown: 0 };
  if (seeded) {
    for (const rep of failures) {
      const kind = attributeFailure({
        retrieval: rep.retrieval,
        success: false,
      });
      if (kind === "utilization") attribution.utilization += 1;
      else if (kind === "retrieval") attribution.retrieval += 1;
      else attribution.unknown += 1;
    }
  }

  // Cost is summed over EVERY rep that ran, including the discarded ones.
  //
  // A contaminated rep is excluded from every RATE — it is not evidence — but
  // it was still billed, and a report that quietly priced only the usable reps
  // would understate what the experiment cost exactly when it went wrong most.
  const billed = all.filter((r) => typeof r.costUsd === "number");
  return {
    arm: armId,
    reps: all.length,
    usableReps: usable.length,
    costUsd:
      billed.length > 0 ? billed.reduce((sum, r) => sum + r.costUsd, 0) : null,
    discardedReps: all.filter((r) => r.discarded).length,
    harnessFaultReps: all.filter(
      (r) => r.retrieval && r.retrieval.state === RETRIEVAL_ABSENT,
    ).length,
    successes,
    successRate: rate(successes, usable.length),
    meanScore:
      scored.length > 0
        ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length
        : null,
    repeatedMistakes: usable.filter((r) => r.repeatedMistake).length,
    repeatedMistakeRate: rate(
      usable.filter((r) => r.repeatedMistake).length,
      usable.length,
    ),
    injectedReps: usable.filter((r) => r.retrieval && r.retrieval.injected)
      .length,
    attribution: seeded ? attribution : null,
  };
}

/**
 * Compare every treatment arm against the baseline.
 *
 * `comparable` is the load-bearing field. A lift computed when either side has
 * no usable reps is not a small number with wide error bars — it is not a number
 * at all, and reporting `0` or `null` as though it were a result is how a broken
 * batch gets read as "memory made no difference".
 *
 * A `--arm` subset that leaves the baseline out lands in exactly the same
 * place: no control summary, so no lift, for every treatment in the run. That
 * is the rule which makes cheap arm subsetting safe, and it is structural — it
 * falls out of the control being absent from `summaries`, not from a check
 * someone has to remember to write. The two cases get DIFFERENT reasons,
 * because "the baseline never ran" and "the baseline ran and every rep was
 * discarded" call for different actions from whoever reads the artifact.
 */
export function compareArms(summaries = [], { baseline = BASELINE_ARM } = {}) {
  const byId = new Map(summaries.map((s) => [s.arm, s]));
  const control = byId.get(baseline) || null;

  const comparisons = [];
  for (const summary of summaries) {
    const arm = GOLDEN_ARMS.find((a) => a.id === summary.arm);
    if (!arm || !arm.isTreatment) continue;

    const comparable = Boolean(
      control && control.usableReps > 0 && summary.usableReps > 0,
    );
    comparisons.push({
      arm: summary.arm,
      baseline,
      comparable,
      baselineUsableReps: control ? control.usableReps : 0,
      treatmentUsableReps: summary.usableReps,
      baselineSuccessRate: control ? control.successRate : null,
      treatmentSuccessRate: summary.successRate,
      // The headline, and deliberately a plain difference in rates.
      successRateLift:
        comparable &&
        control.successRate !== null &&
        summary.successRate !== null
          ? summary.successRate - control.successRate
          : null,
      meanScoreLift:
        comparable && control.meanScore !== null && summary.meanScore !== null
          ? summary.meanScore - control.meanScore
          : null,
      repeatedMistakeDelta:
        comparable &&
        control.repeatedMistakeRate !== null &&
        summary.repeatedMistakeRate !== null
          ? summary.repeatedMistakeRate - control.repeatedMistakeRate
          : null,
      reason: comparable
        ? null
        : control === null
          ? `not comparable: the baseline arm ${baseline} did not run, so ` +
            `there is nothing to measure against. Add --arm ${baseline}.`
          : "not comparable: one or both arms have zero usable reps.",
    });
  }
  return comparisons;
}

/**
 * One line per comparison, phrased so it cannot be quoted as a finding.
 *
 * Every sentence names the N it rests on. That is not decoration: a number
 * lifted out of an artifact months later is the exact thing the package's own
 * README warns about, and the only reliable defence is to make the caveat
 * travel inside the sentence rather than beside it.
 */
export function describeComparison(comparison) {
  if (!comparison.comparable) {
    return `${comparison.arm} vs ${comparison.baseline}: ${comparison.reason}`;
  }
  const pct = (v) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
  const signed = (v) =>
    v === null ? "n/a" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)} pts`;
  return (
    `${comparison.arm} vs ${comparison.baseline}: ` +
    `${pct(comparison.treatmentSuccessRate)} vs ` +
    `${pct(comparison.baselineSuccessRate)} success ` +
    `(${signed(comparison.successRateLift)}), on ` +
    `${comparison.treatmentUsableReps} vs ` +
    `${comparison.baselineUsableReps} usable reps — ` +
    `an INDICATOR at this N, not a significance claim.`
  );
}
