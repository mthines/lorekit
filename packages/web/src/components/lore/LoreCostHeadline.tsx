'use client';

/**
 * LoreCostHeadline — the bill, at the top of the Insights page.
 *
 * WHY IT LEADS. Everything else on this page is a volume, and a volume reads
 * as activity, which reads as health. Stating the same data as a cost — "602M
 * tokens of lore delivered in the last 30 days; 0.19% of it was ever
 * deliberately fetched" — is what turns an unread lesson from a curiosity into
 * something a reader wants to act on. The grid below says WHICH lessons; this
 * says whether it is worth looking at all.
 *
 * TWO QUALIFIERS RENDERED, NOT BURIED, because the number is only honest with
 * them:
 *
 *   - tokens are ESTIMATED at four characters each, never tokenized;
 *   - the share measures SELECTION, not influence. A lesson injected at
 *     SessionStart is already in context and never needs a second fetch to be
 *     acted on, so a low share is "rarely looked up on purpose" and NOT
 *     "wasted". Saying otherwise would make this page argue for pruning lore
 *     that is working.
 *
 * ITS WINDOW IS ITS OWN, and it is stated in the sentence rather than implied
 * by a picker: the grid beneath reads all-time lifetime counters, and the two
 * are different sources on purpose (only this one CAN be windowed). A shared
 * control over the pair would make a reader's "last 7 days" silently narrow a
 * census that never moved.
 */

import { useMemo } from 'react';
import { Coins } from 'lucide-react';
import { useLoreUtility } from '@/lib/queries/lore-utility';
import { readDeliveryCost, CHARS_PER_TOKEN_ESTIMATE } from '@/lib/lore-cost';

/**
 * The window, in days.
 *
 * A rolling 30 days rather than the calendar month the phrase "this month"
 * suggests: on the 2nd of a month the calendar figure is two days of data
 * under a label a reader will compare against last month's thirty, and a bill
 * that collapses at the start of every month is a bill nobody trusts. The
 * caption says "the last 30 days" so the label matches the arithmetic.
 */
const WINDOW_DAYS = 30;

export function LoreCostHeadline() {
  // Mount-stable, so the query key and the caption describe one instant.
  const since = useMemo(
    () => new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString(),
    [],
  );
  // No `until`: the cost sum's upper bound is exclusive of the whole day it
  // names (its source is a daily rollup), so passing `now` would silently drop
  // today. Omitting it is how a caller says "through right now".
  const { data, isLoading, isError } = useLoreUtility({ since });

  if (isError) {
    // Not folded into an empty state: "0 tokens delivered" is a claim, and a
    // failed fetch has not earned it.
    return (
      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 text-xs text-[var(--color-content-secondary)]">
        Failed to load delivery cost. Please refresh the page to try again.
      </p>
    );
  }

  if (isLoading || !data) {
    return (
      <div
        className="h-20 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
        aria-hidden
      />
    );
  }

  const cost = readDeliveryCost(data.cost);

  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      <Coins className="mt-0.5 size-4 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
      <div className="min-w-0">
        {cost.isEmpty ? (
          <p className="text-sm text-[var(--color-content-secondary)]">
            No lore was delivered in the last {WINDOW_DAYS} days.
          </p>
        ) : (
          <p className="text-sm text-[var(--color-content-primary)]">
            <strong className="font-semibold">~{cost.deliveredTokens} tokens</strong> of lore delivered in the last{' '}
            {WINDOW_DAYS} days
            {cost.chosenShareLabel !== null && (
              <>
                {' — '}
                <strong className="font-semibold">{cost.chosenShareLabel}</strong> of it was ever deliberately
                fetched
              </>
            )}
            .
          </p>
        )}
        <p className="mt-1 text-xs text-[var(--color-content-tertiary)]">
          {cost.deliveredReads} deliveries, {cost.chosenReads} of them a targeted fetch. Tokens are estimated at{' '}
          {CHARS_PER_TOKEN_ESTIMATE} characters each, not tokenized. This measures whether lore is looked up on
          purpose, not whether it changed an outcome — a lesson injected at session start is already in context and
          never needs a second fetch.
        </p>
      </div>
    </div>
  );
}
