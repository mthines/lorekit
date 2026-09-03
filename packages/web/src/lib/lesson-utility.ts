/**
 * Is this lesson earning its place? One derived verdict per memory.
 *
 * THE PROBLEM THIS REPLACES. A memory carries three counters and every one of
 * them measures SUPPLY — how often the system produced the lesson:
 *
 * - `seen_count` counts WRITES. On a live 2,475-row sample 88.4% sat at exactly
 *   1, so there is almost no variance to rank by.
 * - `read_count` counts READS, but 99.80% of recorded reads are bulk
 *   ride-alongs in a `memory.list`/`memory.search` page. It therefore ranks
 *   SCOPE BREADTH: a `global` lesson is delivered on every session and a
 *   `branch` lesson almost never, whatever either is worth.
 * - `last_opened_at` is the honest signal — an agent deliberately reaching for
 *   this one lesson — and it is a bare timestamp with no count and no
 *   denominator, so two lessons cannot be compared by it.
 *
 * Value lives on the DEMAND side: given that a lesson was offered, did anything
 * take it up? That is a RATIO, and the ratio cancels the confound — scope
 * breadth appears in both halves and divides away. PULL-THROUGH is
 * `opened_count / read_count` (migration 00104). A `global` lesson delivered
 * 1,300 times and opened twice scores 0.15%; a `branch` lesson delivered 3
 * times and opened twice scores 67%. Those two numbers are comparable, and the
 * second lesson — the one a `read_count` ranking puts on the prune list — is
 * obviously the more valuable.
 *
 * WHAT THIS IS NOT. Pull-through measures SELECTION, not influence. A lesson
 * injected at SessionStart is already in the agent's context and never needs a
 * second fetch to be acted on, so this under-counts the injection path and
 * reads closest to "was this worth an explicit lookup". It is strictly better
 * than any of the three counters and it is not a measure of whether the lesson
 * changed an outcome; only a citation reported by the agent that was influenced
 * could answer that.
 *
 * Pure and clock-injected: the `now` argument makes every verdict testable
 * without freezing time, and keeps the module usable from a server render.
 */

import { LESSON_UTILITY_THRESHOLDS, type LessonUtilityName } from '@lorekit/schemas/memory';

/**
 * Where a lesson sits on the delivered × chosen grid.
 *
 * The diagonal is the boring part; the off-diagonal is where the decisions are.
 * "Delivered a lot, never chosen" is a bill paid every session, and "chosen a
 * lot, barely delivered" is a lesson whose scope is too narrow.
 *
 * Aliased from `@lorekit/schemas` rather than re-spelled: the same five names
 * are the keys of `GET /memories/utility`'s census and the argument its row
 * query takes, so a sixth quadrant invented here alone would render a card the
 * grid has no column for.
 */
export type LessonUtility = LessonUtilityName;

/**
 * The four numbers that draw the grid lines, RE-EXPORTED — not declared here.
 *
 * They live in `@lorekit/schemas` because two implementations read them: this
 * module, for the chip on a single card, and `lorekit_lesson_utility` (00106),
 * for the census over the whole store. The SQL takes them as parameters rather
 * than hardcoding its own, so both consumers are downstream of one definition
 * and a card can never disagree with the quadrant it was counted into. Tuning
 * the calibration is one edit in the schemas package.
 */

/** Deliveries below which a rate is noise. Two opens out of three is 67% and means nothing. */
export const MIN_DELIVERIES_TO_JUDGE = LESSON_UTILITY_THRESHOLDS.minDeliveries;

/** Below this age a lesson has not had a fair chance, however often it was delivered. */
export const MIN_AGE_DAYS_TO_JUDGE = LESSON_UTILITY_THRESHOLDS.minAgeDays;

/** The pull-through at or above which a lesson counts as CHOSEN. */
export const CHOSEN_PULL_THROUGH = LESSON_UTILITY_THRESHOLDS.chosenPullThrough;

/** Deliveries at or above which a lesson counts as BROAD REACH. */
export const BROAD_REACH_DELIVERIES = LESSON_UTILITY_THRESHOLDS.broadReachDeliveries;

export interface LessonUtilityInput {
  /** `read_count` — every read, bulk ride-alongs included. The DENOMINATOR. */
  read_count?: number;
  /** `opened_count` — targeted agent fetches only (00104). The NUMERATOR. */
  opened_count?: number;
  created_at: string;
}

export interface LessonUtilityVerdict {
  utility: LessonUtility;
  /** `read_count`: how many times this lesson was put in front of an agent. */
  delivered: number;
  /** `opened_count`: how many times an agent deliberately fetched it. */
  chosen: number;
  /** `chosen / delivered`, or null when it has never been delivered. */
  pullThrough: number | null;
  /** Deliveries per day since creation — the calibratable form of `delivered`. */
  deliveredPerDay: number;
  /** What to do about it. One verb, matched to the quadrant. */
  action: string;
  /** The numbers behind the verdict, in one line. */
  detail: string;
}

const MS_PER_DAY = 86_400_000;

/** Whole days since `iso`, floored at 0 so a clock skew cannot produce a negative age. */
function ageInDays(iso: string, now: Date): number {
  const created = Date.parse(iso);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, (now.getTime() - created) / MS_PER_DAY);
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** `10.8%`, or `0.15%` where a single decimal would round a real rate to zero. */
export function formatPullThrough(rate: number): string {
  const pct = rate * 100;
  if (pct > 0 && pct < 1) return `${pct.toPrecision(2)}%`;
  return `${pct.toFixed(1)}%`;
}

/** `4.2/day`, or `210/day` once the rate is large enough that a decimal is noise. */
export function formatPerDay(rate: number): string {
  return rate >= 10 ? `${Math.round(rate).toLocaleString('en-US')}/day` : `${rate.toFixed(1)}/day`;
}

/**
 * The verdict for one lesson, or `null` when the backend did not supply the
 * counters.
 *
 * `null` and `'unproven'` are deliberately different answers. `null` means
 * UNMEASURABLE — a pre-00104 backend, so no verdict can honestly be shown and
 * the caller renders nothing. `'unproven'` means measurable but INCONCLUSIVE,
 * which is itself worth showing: today a lesson created yesterday and a lesson
 * dead for a year look identical in the UI.
 */
export function lessonUtility(
  lesson: LessonUtilityInput,
  now: Date = new Date(),
): LessonUtilityVerdict | null {
  const delivered = lesson.read_count;
  const chosen = lesson.opened_count;
  if (delivered === undefined || chosen === undefined) return null;

  const pullThrough = delivered > 0 ? chosen / delivered : null;
  const days = ageInDays(lesson.created_at, now);
  // A lesson created moments ago would divide by ~0 and report a wild rate, so
  // the denominator is at least one day: "delivered 4 times today" is 4/day.
  const deliveredPerDay = delivered / Math.max(1, days);

  // The measured half of the verdict, identical in every branch. Only the
  // quadrant and the one-line detail differ, and the ACTION is read from
  // LESSON_UTILITY_META rather than repeated here — the grid needs the same
  // verb for a quadrant it has no lesson from, so there can only be one copy.
  const verdict = (utility: LessonUtility, detail: string): LessonUtilityVerdict => ({
    utility,
    delivered,
    chosen,
    pullThrough,
    deliveredPerDay,
    action: LESSON_UTILITY_META[utility].action,
    detail,
  });

  if (days < MIN_AGE_DAYS_TO_JUDGE) {
    return verdict('unproven', `${formatCount(delivered)} delivered · created ${Math.floor(days)}d ago`);
  }
  if (delivered < MIN_DELIVERIES_TO_JUDGE) {
    return verdict('unproven', `${formatCount(delivered)} delivered · too few to read a rate from`);
  }

  const isChosen = pullThrough !== null && pullThrough >= CHOSEN_PULL_THROUGH;
  const isBroad = delivered >= BROAD_REACH_DELIVERIES;
  const rate = pullThrough === null ? '' : ` · ${formatPullThrough(pullThrough)} pull-through`;
  const counts = `${formatCount(delivered)} delivered · ${formatCount(chosen)} chosen`;

  if (isChosen) return verdict(isBroad ? 'load-bearing' : 'specialist', `${counts}${rate}`);
  return isBroad
    ? verdict('noise-tax', `${counts} · ${formatPerDay(deliveredPerDay)}`)
    : verdict('dormant', counts);
}

/**
 * Label and tone per verdict, in ONE record rather than parallel maps — adding
 * a sixth quadrant must be a single edit the compiler checks.
 *
 * `tone` names the semantic role, not a colour: the components map it onto the
 * theme tokens they already use for the same meanings elsewhere.
 */
export type LessonUtilityTone = 'positive' | 'informative' | 'warning' | 'neutral';

export interface LessonUtilityMeta {
  label: string;
  tone: LessonUtilityTone;
  description: string;
  /**
   * The one thing to DO about a lesson in this quadrant, as an imperative.
   *
   * It lives here rather than beside each `return` in `lessonUtility` because
   * the grid needs the verb for a quadrant nobody has a lesson from yet —
   * a card's chip and an empty quadrant's heading must say the same word.
   */
  action: string;
}

export const LESSON_UTILITY_META: Record<LessonUtility, LessonUtilityMeta> = {
  'load-bearing': {
    label: 'Load-bearing',
    tone: 'positive',
    description: 'Delivered widely and chosen often. Worth hardening into a permanent rule.',
    action: 'Promote to a rule',
  },
  specialist: {
    label: 'Specialist',
    tone: 'informative',
    description: 'Narrow reach, high uptake. Agents want it — a wider scope would reach more of them.',
    action: 'Broaden its scope',
  },
  'noise-tax': {
    label: 'Noise tax',
    tone: 'warning',
    description:
      'Injected constantly and never deliberately fetched. This is context budget spent every session for nothing.',
    action: 'Prune first',
  },
  dormant: {
    label: 'Dormant',
    tone: 'neutral',
    description: 'Rarely offered and never taken. Nothing is looking for it.',
    action: 'Archive',
  },
  unproven: {
    label: 'Too new to judge',
    tone: 'neutral',
    description:
      'Not enough evidence yet. Shown so a lesson written this week is not mistaken for one that has been dead for a year.',
    action: 'Give it time',
  },
};
