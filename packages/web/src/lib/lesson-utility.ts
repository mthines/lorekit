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
 * `opened_count / read_count` (migration 00103). A `global` lesson delivered
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

/**
 * Where a lesson sits on the delivered × chosen grid.
 *
 * The diagonal is the boring part; the off-diagonal is where the decisions are.
 * "Delivered a lot, never chosen" is a bill paid every session, and "chosen a
 * lot, barely delivered" is a lesson whose scope is too narrow.
 */
export type LessonUtility =
  /** Delivered widely and chosen often. Worth hardening into a permanent rule. */
  | 'load-bearing'
  /** Narrow reach, high uptake. The scope is probably too tight. */
  | 'specialist'
  /** Injected constantly, never chosen. This is the context budget being spent for nothing. */
  | 'noise-tax'
  /** Rarely offered and never taken. Nothing is looking for it. */
  | 'dormant'
  /** Not enough evidence yet — too young, or too few deliveries to read a rate from. */
  | 'unproven';

/**
 * Deliveries below which a rate is noise. Two opens out of three deliveries is
 * 67% and means nothing; the same 67% over three hundred deliveries is a fact.
 */
export const MIN_DELIVERIES_TO_JUDGE = 10;

/**
 * A lesson younger than this has not had a fair chance to be chosen, however
 * many times it has been delivered. Matches the shortest retention window the
 * grooming UI offers, so "too new to judge" here and "too new to prune" there
 * do not disagree.
 */
export const MIN_AGE_DAYS_TO_JUDGE = 7;

/**
 * The pull-through at or above which a lesson counts as CHOSEN.
 *
 * Calibrated against the measured store-wide rate of 0.20% — this is an order
 * of magnitude above the baseline, so clearing it means the lesson is being
 * picked out deliberately rather than riding the average. It is a starting
 * calibration, deliberately in ONE place so it can be tuned against real
 * stores rather than rediscovered in four components.
 */
export const CHOSEN_PULL_THROUGH = 0.02;

/**
 * Deliveries at or above which a lesson counts as BROAD REACH.
 *
 * A hundred deliveries is a lesson riding along in essentially every session
 * for a month — the point at which what it costs in context stops being
 * rounding error and starts being a budget line.
 */
export const BROAD_REACH_DELIVERIES = 100;

export interface LessonUtilityInput {
  /** `read_count` — every read, bulk ride-alongs included. The DENOMINATOR. */
  read_count?: number;
  /** `opened_count` — targeted agent fetches only (00103). The NUMERATOR. */
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
 * UNMEASURABLE — a pre-00103 backend, so no verdict can honestly be shown and
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

  if (days < MIN_AGE_DAYS_TO_JUDGE || delivered < MIN_DELIVERIES_TO_JUDGE) {
    return {
      utility: 'unproven',
      delivered,
      chosen,
      pullThrough,
      deliveredPerDay,
      action: 'Give it time',
      detail:
        days < MIN_AGE_DAYS_TO_JUDGE
          ? `${formatCount(delivered)} delivered · created ${Math.floor(days)}d ago`
          : `${formatCount(delivered)} delivered · too few to read a rate from`,
    };
  }

  const isChosen = pullThrough !== null && pullThrough >= CHOSEN_PULL_THROUGH;
  const isBroad = delivered >= BROAD_REACH_DELIVERIES;
  const rate = pullThrough === null ? '' : ` · ${formatPullThrough(pullThrough)} pull-through`;
  const counts = `${formatCount(delivered)} delivered · ${formatCount(chosen)} chosen`;

  if (isChosen) {
    return isBroad
      ? { utility: 'load-bearing', delivered, chosen, pullThrough, deliveredPerDay,
          action: 'Promote to a rule', detail: `${counts}${rate}` }
      : { utility: 'specialist', delivered, chosen, pullThrough, deliveredPerDay,
          action: 'Broaden its scope', detail: `${counts}${rate}` };
  }

  return isBroad
    ? { utility: 'noise-tax', delivered, chosen, pullThrough, deliveredPerDay,
        action: 'Prune first', detail: `${counts} · ${formatPerDay(deliveredPerDay)}` }
    : { utility: 'dormant', delivered, chosen, pullThrough, deliveredPerDay,
        action: 'Archive', detail: counts };
}

/**
 * Label and tone per verdict, in ONE record rather than parallel maps — adding
 * a sixth quadrant must be a single edit the compiler checks.
 *
 * `tone` names the semantic role, not a colour: the components map it onto the
 * theme tokens they already use for the same meanings elsewhere.
 */
export type LessonUtilityTone = 'positive' | 'informative' | 'warning' | 'neutral';

export const LESSON_UTILITY_META: Record<
  LessonUtility,
  { label: string; tone: LessonUtilityTone; description: string }
> = {
  'load-bearing': {
    label: 'Load-bearing',
    tone: 'positive',
    description: 'Delivered widely and chosen often. Worth hardening into a permanent rule.',
  },
  specialist: {
    label: 'Specialist',
    tone: 'informative',
    description: 'Narrow reach, high uptake. Agents want it — a wider scope would reach more of them.',
  },
  'noise-tax': {
    label: 'Noise tax',
    tone: 'warning',
    description:
      'Injected constantly and never deliberately fetched. This is context budget spent every session for nothing.',
  },
  dormant: {
    label: 'Dormant',
    tone: 'neutral',
    description: 'Rarely offered and never taken. Nothing is looking for it.',
  },
  unproven: {
    label: 'Too new to judge',
    tone: 'neutral',
    description:
      'Not enough evidence yet. Shown so a lesson written this week is not mistaken for one that has been dead for a year.',
  },
};
