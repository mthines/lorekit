/**
 * The paste-ready prompt behind the utility grid's "Copy prompt" button.
 *
 * ## Why a prompt and not a list of keys
 *
 * The button used to copy bare `scope::key` lines. That is the input a grooming
 * agent needs and none of the instruction — so the reader had to supply the
 * verb, the thresholds, and the safety rail themselves, from memory, every
 * time. Worse, the lines alone are ambiguous in the one way that matters: the
 * same list means "prune these" under Noise tax and "promote these" under
 * Load-bearing, and nothing in the clipboard said which quadrant produced it.
 *
 * This assembles the whole hand-off instead — what the quadrant measured, what
 * to do about it, what not to do, and the rows — so pasting it is the action.
 *
 * ## Shape
 *
 * Sectioned with XML tags and with the variable input LAST, which is the
 * `ai-engineering` prompt anatomy: Claude is post-trained on XML boundaries, and
 * putting `<lessons>` after the instructions keeps the rules in the primacy
 * position while the data stays adjacent to the work. The lesson rows are the
 * one part copied verbatim from the server; everything above them is ours.
 *
 * The action menu is CLOSED — a numbered set of choices per quadrant rather
 * than "decide what to do" — because an open-ended grooming instruction is how
 * an agent talks itself into deleting lore. The same reasoning puts the
 * propose-then-wait rule in `<constraints>` as a prohibition rather than a
 * preference: negation outperforms for process rules, where it under-performs
 * for content ones.
 *
 * Pure, and tested from its output alone (`lore-utility-prompt.spec.ts`).
 */

import { LESSON_UTILITY_META, formatPullThrough, type LessonUtility } from './lesson-utility';
import type { UtilityEntry, UtilityResponse } from '@lorekit/schemas/memory';

/** The echoed threshold set — the numbers the SERVER counted with, never re-derived here. */
type Thresholds = UtilityResponse['thresholds'];

interface QuadrantBriefing {
  /**
   * Why these lessons are grouped, phrased in the reader's own thresholds so
   * the prompt explains the same grid the page just showed them.
   */
  evidence: (t: Thresholds) => string;
  /** The CLOSED menu of actions the agent may propose. One is picked per lesson. */
  choices: readonly string[];
  /** An extra prohibition where the quadrant's whole point is that acting would be wrong. */
  caution?: string;
}

/**
 * One record keyed by quadrant, not five parallel maps — a sixth quadrant has
 * to be a single edit the compiler checks, the same rule `LESSON_UTILITY_META`
 * follows for the labels these sit beside.
 */
const BRIEFING: Record<LessonUtility, QuadrantBriefing> = {
  'load-bearing': {
    evidence: (t) =>
      `each was delivered at least ${t.broad_reach_deliveries.toLocaleString('en-US')} times AND deliberately fetched in at least ${formatPullThrough(t.chosen_pull_through)} of those deliveries. This is the lore your agents actually reach for.`,
    choices: [
      'Promote it into a durable project rule (a CLAUDE.md / AGENTS.md entry, or a skill) so it no longer costs a lookup.',
      'Broaden its scope so more sessions are offered it.',
      'Leave it as lore — say why.',
    ],
  },
  specialist: {
    evidence: (t) =>
      `each was deliberately fetched in at least ${formatPullThrough(t.chosen_pull_through)} of its deliveries but delivered fewer than ${t.broad_reach_deliveries.toLocaleString('en-US')} times. Agents want it; few sessions are offered it.`,
    choices: [
      'Widen its scope — name the wider scope explicitly.',
      'Merge it into a broader lesson that already covers the same ground.',
      'Leave it narrow — say why.',
    ],
  },
  'noise-tax': {
    evidence: (t) =>
      `each was delivered at least ${t.broad_reach_deliveries.toLocaleString('en-US')} times but deliberately fetched in under ${formatPullThrough(t.chosen_pull_through)} of those deliveries. This is context budget spent in every session for nothing.`,
    choices: [
      'Archive it.',
      'Narrow its scope to the repo or branch it is actually true for.',
      'Merge it into a lesson that IS being chosen.',
      'Keep it — say why.',
    ],
  },
  dormant: {
    evidence: (t) =>
      `each was delivered fewer than ${t.broad_reach_deliveries.toLocaleString('en-US')} times and deliberately fetched in under ${formatPullThrough(t.chosen_pull_through)} of those deliveries. Nothing is looking for them.`,
    choices: [
      'Archive it.',
      'Rewrite its key and body in the words an agent would actually search for.',
      'Keep it — say why.',
    ],
  },
  unproven: {
    evidence: (t) =>
      `each has under ${t.min_deliveries} deliveries or is younger than ${t.min_age_days} days, so there is not enough evidence to judge it yet.`,
    choices: [
      'Fix its key or body if it is unclear, duplicated, or mis-scoped.',
      'Leave it to accumulate evidence — this is the expected answer for most of them.',
    ],
    caution: 'Do not archive or delete anything in this list: none of it has been measured yet.',
  },
};

/** `scope::key — 1,204 delivered · 2 chosen · 0.17%`, the same three figures the row shows. */
function lessonLine(entry: UtilityEntry): string {
  const counts = `${entry.read_count.toLocaleString('en-US')} delivered · ${entry.opened_count.toLocaleString('en-US')} chosen`;
  const rate = entry.read_count > 0 ? ` · ${formatPullThrough(entry.opened_count / entry.read_count)}` : '';
  return `${entry.scope}::${entry.key} — ${counts}${rate}`;
}

export interface GroomPromptInput {
  quadrant: LessonUtility;
  entries: readonly UtilityEntry[];
  thresholds: Thresholds;
  /** ISO instant read counting began. Rendered as a bare date — see below. */
  countingSince: string;
}

/**
 * Assemble the hand-off for one quadrant.
 *
 * `countingSince` renders as the ISO date alone rather than through
 * `toLocaleDateString`: this string is read by a machine in an unknown locale,
 * where `03/08/2026` is two different days, and a locale-dependent output would
 * make this function's tests depend on the runner's timezone.
 */
export function groomPrompt({ quadrant, entries, thresholds, countingSince }: GroomPromptInput): string {
  const meta = LESSON_UTILITY_META[quadrant];
  const briefing = BRIEFING[quadrant];
  const choices = briefing.choices.map((choice, i) => `${i + 1}. ${choice}`).join('\n');
  const countingSinceDate = countingSince.slice(0, 10);

  return [
    'Groom the LoreKit lessons listed in <lessons>.',
    '',
    '<context>',
    `They are the "${meta.label}" quadrant of LoreKit's utility grid: ${briefing.evidence(thresholds)}`,
    `Counts are all-time since ${countingSinceDate}, so a 0 means "not delivered since then", never "never delivered".`,
    '</context>',
    '',
    '<task>',
    'Read each lesson (the lorekit-groom skill, or memory_read over the LoreKit MCP server),',
    'then propose exactly ONE of these actions per lesson:',
    choices,
    '</task>',
    '',
    '<constraints>',
    'Show me the full proposal and wait for my approval before any write, archive, or delete.',
    'Act only on the lessons inside <lessons>; do not go looking for others.',
    ...(briefing.caution ? [briefing.caution] : []),
    'Answer as a table: scope::key | action | one-line reason.',
    '</constraints>',
    '',
    '<lessons>',
    ...entries.map(lessonLine),
    '</lessons>',
  ].join('\n');
}
