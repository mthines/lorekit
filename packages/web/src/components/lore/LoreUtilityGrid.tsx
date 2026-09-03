'use client';

/**
 * LoreUtilityGrid — every lesson placed on the delivered × chosen grid, and
 * each quadrant handing its rows straight to `lorekit-groom`.
 *
 * WHAT IT REPLACES, AND WHY THAT PANEL WAS MISLEADING. The removed
 * `HotColdLore` panel ranked by `read_count`, and 99.80% of recorded reads are
 * bulk ride-alongs in a `memory.list`/`memory.search` page. So that ranking
 * mostly encodes SCOPE BREADTH: a `global` lesson is delivered on every session
 * however useless, a `branch` lesson almost never however good. Its "cold" end
 * — presented as a prune list — was therefore a list of NARROW SCOPES, and
 * following it would have pruned the most specific lore in the account. Pull-through
 * (`opened_count / read_count`, migration 00104) is a proper fraction, so the
 * breadth appears in both halves and cancels.
 *
 * FIVE STATES, NOT FOUR. The fifth — "Too new to judge" — is the one this
 * surface exists to add as much as the quadrants are: today a lesson written
 * this week and a lesson dead for a year render identically, so a reader
 * cannot tell a verdict from an absence of evidence. It is shown as a
 * full-width strip UNDER the 2×2 rather than a fifth cell, because it is not a
 * position on the axes — it is the state of having no position yet.
 *
 * THE COUNTS ARE ALL-TIME; THE COST LINE ABOVE IS WINDOWED. Two different
 * sources (`memories`' lifetime counters vs a `memory_read_daily` sum) because
 * only one of them can be windowed at all — see `GET /memories/utility`. Each
 * captions its own period rather than implying a shared one.
 *
 * SELECTION SWAPS THE ROWS, it does not open a second view. Picking a quadrant
 * fetches only that quadrant (`useLoreUtilityRows`, `enabled` on a selection)
 * and lists it below the grid; picking it again clears it. Nothing is fetched
 * until a reader asks — the same posture the Explorer's clusters sidebar takes.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Copy, Check, ArrowUpRight } from 'lucide-react';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { useLoreUtility, useLoreUtilityRows } from '@/lib/queries/lore-utility';
import { LESSON_UTILITY_META, formatPullThrough, type LessonUtility } from '@/lib/lesson-utility';
import { scopeType } from '@/lib/scope';
import type { LessonUtilityTone } from '@/lib/lesson-utility';
import type { UtilityEntry } from '@lorekit/schemas/memory';

/**
 * The 2×2, in reading order: chosen on top, ignored below; broad on the left,
 * narrow on the right.
 *
 * Ordered so the two ACTIONABLE quadrants sit on the same diagonal a reader's
 * eye crosses first — "prune this" and "broaden this" are the two decisions
 * this page is for, and "load-bearing" is the one cell that asks for nothing.
 */
const GRID_QUADRANTS: readonly LessonUtility[] = ['load-bearing', 'specialist', 'noise-tax', 'dormant'];

/** Tone → the theme tokens the rest of the dashboard already uses for that meaning. */
const TONE_CLASS: Record<LessonUtilityTone, { border: string; text: string }> = {
  positive: { border: 'border-[var(--color-success)]/40', text: 'text-[var(--color-success)]' },
  informative: { border: 'border-[var(--color-accent)]/40', text: 'text-[var(--color-accent)]' },
  warning: { border: 'border-[var(--color-warning)]/40', text: 'text-[var(--color-warning)]' },
  neutral: { border: 'border-[var(--color-border)]', text: 'text-[var(--color-content-tertiary)]' },
};

/** `scope::key` lines for the groom handoff — the shape `lorekit groom` reads. */
function groomList(entries: readonly UtilityEntry[]): string {
  return entries.map((e) => `${e.scope}::${e.key}`).join('\n');
}

function formatCountingSince(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function LoreUtilityGrid() {
  const [selected, setSelected] = useState<LessonUtility | null>(null);
  // Account-wide: the page it lives on has no scope filter, and the hooks take
  // one only because the route does.
  const census = useLoreUtility({});
  const rows = useLoreUtilityRows(selected);

  if (census.isError) {
    // NEVER fold a failed request into the empty state — the same trap the
    // removed `HotColdLore` panel documented. A grid rendering five zeroes on a
    // failed fetch reads as "you have no lore", the one message that hides the
    // defect completely.
    return (
      <p className="text-xs text-[var(--color-content-secondary)]">
        Failed to load the utility grid. Please refresh the page to try again.
      </p>
    );
  }

  if (census.isLoading || !census.data) {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-[var(--color-bg-elevated)]" />
        ))}
      </div>
    );
  }

  const { census: counts, thresholds, counting_since: countingSince } = census.data;
  const judged = GRID_QUADRANTS.reduce((sum, q) => sum + counts[q], 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {GRID_QUADRANTS.map((quadrant) => (
          <QuadrantCell
            key={quadrant}
            quadrant={quadrant}
            count={counts[quadrant]}
            share={judged > 0 ? counts[quadrant] / judged : null}
            selected={selected === quadrant}
            onSelect={() => setSelected(selected === quadrant ? null : quadrant)}
          />
        ))}
      </div>

      <QuadrantCell
        quadrant="unproven"
        count={counts.unproven}
        share={null}
        selected={selected === 'unproven'}
        onSelect={() => setSelected(selected === 'unproven' ? null : 'unproven')}
      />

      <p className="text-xs text-[var(--color-content-tertiary)]">
        A lesson is <strong className="font-medium text-[var(--color-content-secondary)]">chosen</strong> when at
        least {formatPullThrough(thresholds.chosen_pull_through)} of its deliveries were a deliberate fetch, and{' '}
        <strong className="font-medium text-[var(--color-content-secondary)]">broad</strong> at{' '}
        {thresholds.broad_reach_deliveries.toLocaleString('en-US')} deliveries. Below{' '}
        {thresholds.min_deliveries} deliveries or {thresholds.min_age_days} days old there is not enough evidence
        to judge. Counting began {formatCountingSince(countingSince)} — a 0 means &ldquo;not since then&rdquo;,
        never &ldquo;never&rdquo;.
      </p>

      {selected && <QuadrantRows quadrant={selected} query={rows} />}
    </div>
  );
}

function QuadrantCell({
  quadrant,
  count,
  share,
  selected,
  onSelect,
}: {
  quadrant: LessonUtility;
  count: number;
  share: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = LESSON_UTILITY_META[quadrant];
  const tone = TONE_CLASS[meta.tone];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex flex-col items-start gap-1 rounded-xl border bg-[var(--color-bg-elevated)] p-3 text-left transition-colors duration-150 hover:bg-[var(--color-bg-raised)] ${
        selected ? 'border-[var(--color-accent)] bg-[var(--color-bg-raised)]' : tone.border
      }`}
    >
      <div className="flex w-full items-baseline justify-between gap-2">
        <span className={`text-xs font-semibold ${tone.text}`}>{meta.label}</span>
        <span className="font-mono text-lg font-semibold text-[var(--color-content-primary)]">
          {count.toLocaleString('en-US')}
          {share !== null && count > 0 && (
            <span className="ml-1 font-sans text-xs font-normal text-[var(--color-content-tertiary)]">
              {Math.round(share * 100)}%
            </span>
          )}
        </span>
      </div>
      <p className="text-xs text-[var(--color-content-tertiary)]">{meta.description}</p>
      <span className="text-xs font-medium text-[var(--color-content-secondary)]">→ {meta.action}</span>
    </button>
  );
}

function QuadrantRows({
  quadrant,
  query,
}: {
  quadrant: LessonUtility;
  query: ReturnType<typeof useLoreUtilityRows>;
}) {
  const [copied, setCopied] = useState(false);
  const entries = query.data?.entries ?? [];
  const meta = LESSON_UTILITY_META[quadrant];

  async function handleCopyForGroom() {
    try {
      await navigator.clipboard.writeText(groomList(entries));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied/unavailable — no crash, just no confirmation.
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--color-content-primary)]">
          {meta.label} — {meta.action}
        </h3>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={handleCopyForGroom}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-2.5 py-1.5 text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
          >
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy for groom'}
          </button>
        )}
      </div>

      {query.isError ? (
        <p className="text-xs text-[var(--color-content-secondary)]">
          Failed to load this quadrant. Please refresh the page to try again.
        </p>
      ) : query.isLoading ? (
        <div className="flex flex-col gap-1.5" aria-hidden>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-xs text-[var(--color-content-tertiary)]">Nothing sits in this quadrant.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <UtilityRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Deep-links a row into the Explorer.
 *
 * `?scope=` + `?q=` rather than an id, for the reason the removed `HotColdLore`
 * panel gave: the Explorer has no `?lesson=` param, so the closest honest
 * target is its list narrowed to the one scope and searched for the key.
 */
function explorerHref(entry: UtilityEntry): string {
  return `/lore?scope=${encodeURIComponent(entry.scope)}&q=${encodeURIComponent(entry.key)}`;
}

function UtilityRow({ entry }: { entry: UtilityEntry }) {
  const pullThrough = entry.read_count > 0 ? entry.opened_count / entry.read_count : null;
  return (
    <li>
      {/* The row IS the link — acting on a quadrant means reading the lesson
          first, and leaving the row inert made that a manual re-search. */}
      <Link
        href={explorerHref(entry)}
        className="flex min-h-8 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-2 text-xs transition-colors duration-150 hover:border-[var(--color-accent)]"
        title={`Open ${entry.scope}::${entry.key} in the Lore Explorer`}
      >
        <ScopeBadge scope={entry.scope} type={scopeType(entry.scope)} showType={false} label className="shrink-0" />
        <code className="min-w-0 flex-1 truncate font-mono text-[var(--color-content-secondary)]">{entry.key}</code>
        <span className="shrink-0 font-mono text-[var(--color-content-tertiary)]">
          {entry.read_count.toLocaleString('en-US')} delivered · {entry.opened_count.toLocaleString('en-US')} chosen
          {pullThrough !== null && ` · ${formatPullThrough(pullThrough)}`}
        </span>
        <ArrowUpRight className="hidden size-3.5 shrink-0 text-[var(--color-content-tertiary)] sm:block" aria-hidden />
      </Link>
    </li>
  );
}
