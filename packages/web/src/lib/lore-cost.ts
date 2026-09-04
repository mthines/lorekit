/**
 * The cost line: what delivering lore is spending, and how much of that spend
 * anything ever reached for.
 *
 * WHY IT LEADS THE PAGE. Every other number on Insights is a volume — reads,
 * writes, scopes, runs — and a volume alone reads as activity, which reads as
 * health. "602M tokens delivered, 0.19% deliberately fetched" is the same data
 * turned into a bill, and a bill is the thing that makes an unread lesson feel
 * like a cost rather than a curiosity. The grid below it says WHICH lessons;
 * this says whether it is worth looking.
 *
 * TWO HONEST QUALIFIERS, both non-negotiable when rendering:
 *
 *   - Tokens are ESTIMATED at four characters each (`CHARS_PER_TOKEN_ESTIMATE`,
 *     shared with the SQL that sums them), never tokenized. The figure is an
 *     order of magnitude.
 *   - The share is SELECTION, not influence. A lesson injected at SessionStart
 *     is already in context and never needs a second fetch to be acted on, so
 *     a low share means "rarely looked up on purpose" and NOT "wasted". The
 *     honest claim about waste is per-lesson, and that is what the grid is for.
 *
 * Pure and total: every function here answers for an empty account without a
 * division by zero and without a caller-side guard.
 */

import { CHARS_PER_TOKEN_ESTIMATE, type UtilityCost } from '@lorekit/schemas/memory';

export { CHARS_PER_TOKEN_ESTIMATE };

/**
 * `602M`, `1.2M`, `84K`, `840`.
 *
 * Thresholded rather than always-suffixed: `0.8K` is harder to read than `840`,
 * and a headline exists to be read at a glance. One decimal below 10 of a unit
 * (`1.2M`), none above it (`602M`) — the second digit of a 602-million-token
 * estimate is noise the estimate cannot support.
 */
export function formatTokenVolume(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1_000) return String(n);
  for (const [unit, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (n >= unit) {
      const scaled = n / unit;
      return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)}${suffix}`;
    }
  }
  return String(n);
}

/**
 * `0.19%`, `12.4%`, `0%`.
 *
 * Two significant figures below 1% because the interesting rates live there:
 * the measured store-wide baseline is 0.20%, and `0.2%` rounded to one decimal
 * would make 0.15% and 0.24% the same number. `null` (no denominator) is not a
 * rate and is left for the caller to phrase.
 */
export function formatShare(share: number | null): string | null {
  if (share === null) return null;
  const pct = share * 100;
  if (pct > 0 && pct < 1) return `${pct.toPrecision(2)}%`;
  return pct % 1 === 0 ? `${pct}%` : `${pct.toFixed(1)}%`;
}

export interface DeliveryCostReading {
  /** Estimated tokens delivered, formatted. */
  deliveredTokens: string;
  /** Estimated tokens that were a deliberate fetch, formatted. */
  chosenTokens: string;
  /** `chosen_tokens / delivered_tokens`, or null when nothing was delivered. */
  chosenShare: number | null;
  /** The share, formatted — or null when there is no denominator. */
  chosenShareLabel: string | null;
  /** Raw read counts, formatted with thousands separators. */
  deliveredReads: string;
  chosenReads: string;
  /** True when the window recorded nothing at all — the caller says so in words. */
  isEmpty: boolean;
}

/**
 * The cost figures a headline needs, formatted once.
 *
 * The share is over TOKENS, not reads, deliberately: the headline is a token
 * volume, so a percentage beside it that silently switched denominator would
 * be read as a share of that volume. Both read counts travel too, for the
 * secondary line — a long lesson and a short one cost differently but are one
 * delivery each, and the two numbers together are what show that.
 */
export function readDeliveryCost(cost: UtilityCost): DeliveryCostReading {
  const chosenShare = cost.delivered_tokens > 0 ? cost.chosen_tokens / cost.delivered_tokens : null;
  return {
    deliveredTokens: formatTokenVolume(cost.delivered_tokens),
    chosenTokens: formatTokenVolume(cost.chosen_tokens),
    chosenShare,
    chosenShareLabel: formatShare(chosenShare),
    deliveredReads: cost.delivered_reads.toLocaleString('en-US'),
    chosenReads: cost.chosen_reads.toLocaleString('en-US'),
    isEmpty: cost.delivered_reads === 0,
  };
}
