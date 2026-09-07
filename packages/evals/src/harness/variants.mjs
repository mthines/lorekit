// The lesson-VARIANT axis: which framing of the same fact teaches best.
//
// `golden.mjs` varies the STORE (empty vs. seeded) and holds the lesson fixed,
// so it can answer "does a stored lesson help?" and nothing else. The question
// this module adds is the next one: given that a lesson helps, WHICH WORDING of
// it helps most, and what does that wording cost?
//
// THE DESIGN IS AN ABLATION LADDER, NOT A BEAUTY CONTEST.
// Every variant below states the SAME underlying fact. They differ only in
// which INGREDIENTS they carry (trigger, rule, example, anti-example,
// consequence) and in how those ingredients are phrased. That is what makes a
// difference in outcome attributable to the framing rather than to the content:
// a variant that also knew more would win for an uninteresting reason.
//
// TWO NUMBERS, NOT ONE — VALUE IS A DIFFERENCE OF DIFFERENCES.
// A framing is only worth its place in every future session if it helps on the
// task it is about WITHOUT dragging on tasks it is not about. Every SessionStart
// injects the whole precedence-resolved set, so a lesson that sharpens one task
// and misdirects a neighbouring one may be net-negative even with a large
// on-target lift. Each variant is therefore run against BOTH tasks in
// `task.mjs` — the on-target `branch-scope` and the off-target `repo-scope` —
// and scored on the pair.
//
// WHY `repo-scope` IS THE OFF-TARGET TASK.
// It is a NEIGHBOUR, not a stranger: it asks for a repo-wide scope, which the
// lesson also mentions, in a directory the lesson's advice is about. That makes
// it the cheap, sharp probe for the specific failure a strongly-worded lesson
// causes — OVER-APPLICATION, writing `branch::…` when `repo::…` was asked — and
// the existing rubric already scores exactly that at 60 with no new grader. It
// is deliberately NOT a measure of pure irrelevance cost; a genuinely unrelated
// task would measure that, and is the follow-up this file does not pretend to
// cover.
//
// THE KEY IS PART OF THE FRAMING.
// A lesson's key is injected with its body and is the first thing read, so it
// is as much a framing decision as the prose. It is held CONSTANT across the
// ladder so the body is the only variable, and varied in exactly one dedicated
// variant (`full-opaque-key`) so its effect is separable rather than smeared
// across every row.
import { summarizeArm } from "./golden.mjs";

/**
 * The four chars-per-token estimate the product's own cost headline uses.
 *
 * Deliberately the SAME constant as `LoreCostHeadline`, and deliberately not a
 * tokenizer: the eval's cost number and the dashboard's cost number have to be
 * the same kind of estimate, or a framing that looks affordable here reads as
 * expensive there and nobody can tell which surface is wrong.
 */
export const CHARS_PER_TOKEN = 4;

/** Estimated context cost of a string, in tokens. Never negative, never NaN. */
export function estimateTokens(text) {
  if (typeof text !== "string" || text === "") return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export const INGREDIENT_TRIGGER = "trigger";
export const INGREDIENT_RULE = "rule";
export const INGREDIENT_EXAMPLE = "example";
export const INGREDIENT_ANTI_EXAMPLE = "anti-example";
export const INGREDIENT_CONSEQUENCE = "consequence";

export const INGREDIENTS = [
  INGREDIENT_TRIGGER,
  INGREDIENT_RULE,
  INGREDIENT_EXAMPLE,
  INGREDIENT_ANTI_EXAMPLE,
  INGREDIENT_CONSEQUENCE,
];

/**
 * The ingredient texts.
 *
 * Every concrete scope written here names `acme/widgets` and `fix/login` — a
 * repository and branch that appear NOWHERE in either task. A variant that
 * quoted the graded target verbatim would measure copying rather than recall,
 * which is the one way this whole axis could report a large, meaningless lift.
 * `variants.test.mjs` asserts it of every rendered variant rather than trusting
 * it of every future edit here.
 */
const IN = {
  [INGREDIENT_TRIGGER]:
    "When you are about to record a memory whose scope names one specific " +
    "branch of one specific repository:",
  [INGREDIENT_RULE]:
    "Scope strings use `::` as the only segment separator, and the branch " +
    "form carries both the repository and the branch: " +
    "`branch::{owner}/{repo}::{branch}`. All segments are lowercased.",
  [INGREDIENT_EXAMPLE]: "Correct: `branch::acme/widgets::fix/login`.",
  [INGREDIENT_ANTI_EXAMPLE]:
    "Two wrong forms keep recurring: `branch:acme/widgets` (a single colon) " +
    "and `branch::acme/widgets/fix/login` (the branch appended with a slash). " +
    "Both are rejected.",
  [INGREDIENT_CONSEQUENCE]:
    "The rejection arrives after the work is done, so the memory has to be " +
    "written again at the end of the turn, when the context that produced it " +
    "is already gone.",
};

/** The key every variant shares, so the BODY is the only thing that moves. */
export const SHARED_KEY = "scope-format::double-colon-is-the-only-separator";

/**
 * The key `full-opaque-key` uses instead.
 *
 * It is well-formed and unremarkable — the shape a retrospective writes when it
 * names the session rather than the lesson. It carries no clue about what the
 * body says, which is the whole variable.
 */
export const OPAQUE_KEY = "notes::session-followup-3";

/** Compose a body from ingredients, in the canonical reading order. */
function compose(ingredients) {
  return ingredients.map((name) => IN[name]).join("\n\n");
}

/**
 * Filler for the `padded` variant.
 *
 * True, on-topic-for-LoreKit, and useless for the task — which is the point.
 * It must not touch scope SYNTAX, or `padded` would differ from `full` in
 * content as well as in length and stop being an ablation of length alone.
 *
 * Its VOLUME is load-bearing too. A lesson padded by half again is not a test
 * of dilution — nothing would be expected to move — so the filler is sized to
 * take `padded` to roughly three times `full`, and a test pins that ratio
 * rather than leaving it to whatever the paragraphs happen to weigh.
 */
const FILLER = [
  "Memories are capped per account and the cap is enforced by a database " +
    "trigger rather than by the client, so a write that exceeds it fails at " +
    "the moment of insertion.",
  "Requests are rate limited per minute across every tool, and a blocked " +
    "request comes back with a Retry-After header rather than a silent drop.",
  "Archiving a memory hides it from reads without deleting it; purging is a " +
    "separate, irreversible sweep that refuses to run against a single key.",
  "Tokens are stored only as a hash, so a token that has been shown once and " +
    "lost cannot be recovered and has to be reissued.",
  "Read counters move when a memory is delivered or opened, and the write " +
    "timestamp deliberately does not move with them, so recent reading cannot " +
    "reorder a list that is sorted by when things were last written.",
  "A memory can be shared with an organization rather than owned personally, " +
    "and which of the two a write lands in is decided by a binding an admin " +
    "configures rather than by anything the caller passes.",
  "Search is full-text on the server and a plain substring match offline, so " +
    "the same query can rank differently depending on which of the two " +
    "answered it, and ordering is by recency rather than by relevance.",
  "Telemetry from the command line carries an installation identifier that is " +
    "minted locally and an account identifier that is learned from a response " +
    "header, so an offline run can still be joined to a server-side one later.",
  "Every tool call is recorded once per surface in the dispatcher rather than " +
    "in each handler, which is why a REST route reports the name of the tool " +
    "it corresponds to rather than the name of the route.",
].join("\n\n");

/**
 * The ladder.
 *
 * Ordered from the most reduced framing to the most elaborate, then the three
 * rewrites of the fullest one (`imperative`, `narrative`, `untriggered`) and
 * the two cost probes (`padded`, `full-opaque-key`). Each row names the ONE
 * thing it is asking about, because a variant whose question is not written
 * down becomes a row nobody can interpret six months later.
 */
export const LESSON_VARIANTS = [
  {
    id: "rule-only",
    asks: "Is the bare rule enough, with no example and no failure mode?",
    ingredients: [INGREDIENT_RULE],
    key: SHARED_KEY,
  },
  {
    id: "rule-example",
    asks: "Does one concrete correct example beat the rule alone?",
    ingredients: [INGREDIENT_RULE, INGREDIENT_EXAMPLE],
    key: SHARED_KEY,
  },
  {
    id: "rule-antiexample",
    asks: "Does naming the wrong forms beat showing the right one?",
    ingredients: [INGREDIENT_RULE, INGREDIENT_ANTI_EXAMPLE],
    key: SHARED_KEY,
  },
  {
    id: "full",
    asks: "What does everything at once achieve, and at what cost?",
    ingredients: INGREDIENTS,
    key: SHARED_KEY,
  },
  {
    id: "imperative",
    asks: "Do terse directives beat the same content stated descriptively?",
    key: SHARED_KEY,
    ingredients: INGREDIENTS,
    body: [
      "ALWAYS separate scope segments with `::`.",
      "NEVER write a single `:` between segments.",
      "NEVER append a branch after a `/`.",
      "The branch form is `branch::{owner}/{repo}::{branch}`, lowercased — " +
        "for example `branch::acme/widgets::fix/login`, never " +
        "`branch:acme/widgets` and never `branch::acme/widgets/fix/login`.",
      "Getting this wrong costs the write and forces a retry at the end of " +
        "the turn.",
    ].join("\n"),
  },
  {
    id: "narrative",
    asks: "Does a first-person account of the failure beat a stated rule?",
    key: SHARED_KEY,
    ingredients: INGREDIENTS,
    body: [
      "Last time I recorded a branch-specific memory I wrote " +
        "`branch:acme/widgets` with a single colon and the write was rejected.",
      "I tried again with `branch::acme/widgets/fix/login`, appending the " +
        "branch after a slash, and that was rejected too.",
      "What worked was `branch::acme/widgets::fix/login` — `::` between every " +
        "segment, including between the repository and the branch, all " +
        "lowercased.",
      "Both rejections arrived after the work was finished, so I had to " +
        "reconstruct the memory at the end of the turn.",
    ].join("\n\n"),
  },
  {
    id: "untriggered",
    asks: "Does removing the statement of WHEN it applies cost anything?",
    ingredients: [
      INGREDIENT_RULE,
      INGREDIENT_EXAMPLE,
      INGREDIENT_ANTI_EXAMPLE,
      INGREDIENT_CONSEQUENCE,
    ],
    key: SHARED_KEY,
  },
  {
    id: "padded",
    asks: "Does length alone dilute a lesson whose content is unchanged?",
    ingredients: INGREDIENTS,
    key: SHARED_KEY,
    body: `${compose(INGREDIENTS)}\n\n${FILLER}`,
  },
  {
    id: "full-opaque-key",
    asks: "How much of a lesson's effect is carried by its KEY alone?",
    ingredients: INGREDIENTS,
    key: OPAQUE_KEY,
  },
];

export const VARIANT_IDS = LESSON_VARIANTS.map((v) => v.id);

/** Look up a variant, refusing an unknown id rather than running nothing. */
export function variantById(id) {
  const found = LESSON_VARIANTS.find((v) => v.id === id);
  if (!found) {
    throw new Error(
      `unknown variant "${id}"; known: ${VARIANT_IDS.join(", ")}`,
    );
  }
  return found;
}

/**
 * Render a variant to the exact `{ key, body }` that will be seeded, plus its
 * measured cost. `body` is the declared override when there is one and the
 * composition of the declared ingredients otherwise — so the `ingredients`
 * field always describes what the body CONTAINS, whether or not it built it.
 */
export function renderVariant(id) {
  const variant = variantById(id);
  const body = variant.body || compose(variant.ingredients);
  const key = variant.key;
  return {
    id: variant.id,
    asks: variant.asks,
    ingredients: [...variant.ingredients],
    key,
    body,
    // The key is injected alongside the body, so the cost is the pair.
    chars: key.length + body.length,
    estTokens: estimateTokens(key) + estimateTokens(body),
  };
}

/** Every variant, rendered. */
export function renderAllVariants() {
  return VARIANT_IDS.map(renderVariant);
}

// The floor a net lift must clear before it counts as a gain. `netLift` is a
// sum of floats, so an exact wash lands near zero rather than on it; anything
// under a tenth of a basis point is dust this harness cannot resolve.
const NET_LIFT_EPSILON = 1e-9;

/**
 * Score one variant from the four cells it needs.
 *
 * The arithmetic is a difference of differences, and every part of it is
 * refused rather than approximated when a cell has no usable reps: a variant
 * whose off-target arm was entirely discarded has an UNKNOWN net value, and
 * reporting that as its on-target lift would publish the flattering half of a
 * measurement that did not finish.
 *
 * @param {object} args
 * @param {object} args.variant                a `renderVariant` result
 * @param {object} args.onTarget               summarizeArm over the on-target reps
 * @param {object} args.offTarget              …or null when off-target was skipped
 * @param {object} args.baselineOnTarget       the empty-store control, same task
 * @param {object} args.baselineOffTarget      …and for the off-target task
 */
export function scoreVariant({
  variant,
  onTarget,
  offTarget = null,
  baselineOnTarget,
  baselineOffTarget = null,
} = {}) {
  const usable = (cell) => Boolean(cell) && cell.usableReps > 0;
  // An ABSENT cell discarded nothing — it was never run. That is a different
  // statement from "ran and threw everything away", and both render as 0 here,
  // so the two are told apart by `offTargetRun` rather than by this number.
  const cellDiscards = (cell) =>
    cell && typeof cell.discardedReps === "number" ? cell.discardedReps : 0;
  const onComparable = usable(onTarget) && usable(baselineOnTarget);
  // Skipping the off-target task is a deliberate, cheaper mode; failing to
  // MEASURE it is not. The two must stay distinguishable, so `offTargetRun`
  // records which of them happened and no consumer has to infer it from nulls.
  const offRequested = offTarget !== null || baselineOffTarget !== null;
  const offComparable =
    offRequested && usable(offTarget) && usable(baselineOffTarget);

  const onTargetLift = onComparable
    ? onTarget.successRate - baselineOnTarget.successRate
    : null;
  const offTargetDelta = offComparable
    ? offTarget.successRate - baselineOffTarget.successRate
    : null;

  // Downside off-target is charged in full; upside is NOT credited.
  //
  // The lesson is not about the off-target task, so an apparent gain there is
  // far likelier to be noise at these rep counts than a real transfer effect,
  // while a loss is exactly the misdirection this pair exists to catch. The
  // asymmetry biases the score AGAINST the lesson, which is the safe direction
  // for a number whose whole job is to justify occupying every future session.
  let netLift = null;
  if (onTargetLift !== null) {
    if (!offRequested) netLift = null;
    else if (offTargetDelta !== null) {
      netLift = onTargetLift + Math.min(0, offTargetDelta);
    }
  }

  // Cost per point is only meaningful for a variant that actually gained. A
  // zero or negative net lift has no "cost per point of lift" — dividing would
  // manufacture an infinity or, worse, a flattering negative.
  //
  // The bar is an EPSILON, not `> 0`: `netLift` is a sum of two floats, so a
  // genuine wash lands a hair off zero rather than on it (2.78e-17 observed),
  // clears a bare `> 0`, and prints a `tokensPerPoint` in the tens of
  // quadrillions beside a rendered `net +0pp`. A tenth of a basis point of
  // lift is below anything this harness can resolve at N=3 anyway.
  const tokensPerPoint =
    netLift !== null && netLift > NET_LIFT_EPSILON
      ? Math.round(variant.estTokens / (netLift * 100))
      : null;

  return {
    variant: variant.id,
    asks: variant.asks,
    key: variant.key,
    ingredients: variant.ingredients,
    estTokens: variant.estTokens,
    offTargetRun: offRequested,
    comparable: onComparable && (!offRequested || offComparable),
    onTargetLift,
    offTargetDelta,
    netLift,
    tokensPerPoint,
    usableReps: {
      onTarget: usable(onTarget) ? onTarget.usableReps : 0,
      offTarget: usable(offTarget) ? offTarget.usableReps : 0,
      baselineOnTarget: usable(baselineOnTarget)
        ? baselineOnTarget.usableReps
        : 0,
      baselineOffTarget: usable(baselineOffTarget)
        ? baselineOffTarget.usableReps
        : 0,
    },
    // The discard count travels WITH the usable count, because the pair is the
    // claim: "3 usable" means something different after 0 discards than after
    // 5, and a reader given only the first cannot tell a clean cell from a
    // salvaged one. `cells` has always carried it (`summarizeCell` delegates
    // to `summarizeArm`), but this projection dropped it, so every consumer
    // reading `ranked[]` — the step summary among them — could report the
    // usable half alone.
    //
    // Counted UNCONDITIONALLY, with no `usable()` guard: a cell with zero
    // usable reps is precisely the one whose discard count the reader needs,
    // and gating it would zero out the only number explaining the emptiness.
    discardedReps: {
      onTarget: cellDiscards(onTarget),
      offTarget: cellDiscards(offTarget),
      baselineOnTarget: cellDiscards(baselineOnTarget),
      baselineOffTarget: cellDiscards(baselineOffTarget),
    },
  };
}

/**
 * Rank scored variants, best net value first.
 *
 * A variant that could not be scored is never ranked ABOVE one that could, and
 * never given a rank at all — a `rank: null` row at the bottom is a variant
 * whose measurement did not finish, and calling it "worst" would be a claim the
 * run has no evidence for. Ties break toward the CHEAPER framing, because two
 * framings that teach equally well are not equally good.
 */
export function rankVariants(scored = []) {
  const rankable = scored.filter((s) => s.comparable && s.netLift !== null);
  const unrankable = scored.filter(
    (s) => !(s.comparable && s.netLift !== null),
  );
  rankable.sort(
    (a, b) => b.netLift - a.netLift || a.estTokens - b.estTokens || 0,
  );
  return [
    ...rankable.map((s, i) => ({ ...s, rank: i + 1 })),
    ...unrankable.map((s) => ({ ...s, rank: null })),
  ];
}

/** One sentence per variant, carrying its N and refusing to overclaim. */
export function describeVariant(scored) {
  const n = scored.usableReps;
  // The discard total across all four cells. Appended ONLY when non-zero: a
  // clean run should not carry "0 discarded" on every line, but a line resting
  // on salvaged data must say so — "3 usable" reads very differently after 4
  // discards, and this sentence is the surface most likely to be quoted
  // without the table beside it. Deliberately a TOTAL, not a per-cell
  // breakdown, because the breakdown already rides on `ranked[]` and the
  // wording here says which reps it is counting.
  const d = scored.discardedReps || {};
  const discarded =
    (d.onTarget || 0) +
    (d.offTarget || 0) +
    (d.baselineOnTarget || 0) +
    (d.baselineOffTarget || 0);
  const reps =
    `on-target ${n.onTarget} vs ${n.baselineOnTarget} usable reps` +
    (scored.offTargetRun
      ? `, off-target ${n.offTarget} vs ${n.baselineOffTarget}`
      : ", off-target not run") +
    (discarded > 0 ? `; ${discarded} discarded across all cells` : "");
  if (!scored.comparable) {
    return `${scored.variant}: not comparable (${reps}).`;
  }
  const pct = (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}pp`;
  const net =
    scored.netLift === null
      ? "net value unknown without the off-target task"
      : `net ${pct(scored.netLift)}`;
  const cost =
    scored.tokensPerPoint === null
      ? `${scored.estTokens} tokens of context, no measured gain to price`
      : `${scored.estTokens} tokens of context, ~${scored.tokensPerPoint} per point`;
  return (
    `${scored.variant}: on-target ${pct(scored.onTargetLift)}` +
    (scored.offTargetDelta === null
      ? ""
      : `, off-target ${pct(scored.offTargetDelta)}`) +
    `, ${net}; ${cost} (${reps}). An INDICATOR at this N, not a ` +
    `significance claim.`
  );
}

/**
 * Summarize one variant × task cell from its reps.
 *
 * A thin alias for `summarizeArm` so a cell and a golden arm are summarized by
 * the SAME code — `usableReps`, the discard rules and the retrieval attribution
 * all have to mean the same thing across the two experiments, or a rate quoted
 * from one cannot be read beside a rate quoted from the other.
 */
export function summarizeCell(cellId, reps = []) {
  return summarizeArm(cellId, reps);
}
