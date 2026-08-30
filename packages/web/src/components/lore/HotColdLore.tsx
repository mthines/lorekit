'use client';

/**
 * HotColdLore — memories ranked by how often they have actually been READ
 * (`memories.read_count`, migration 00077), not written. The single most
 * actionable view in Wave E: "these lessons have not been read since
 * <counting_since>" is a prune list, exactly the input the `lorekit-groom`
 * skill exists to consume — so the panel makes handing that list off explicit
 * (a copy-to-clipboard of `scope::key` lines) rather than leaving a reader to
 * transcribe rows by hand.
 *
 * `read_count: 0` is qualified with `counting_since` everywhere it renders —
 * NEVER presented as "never read". A memory written before per-memory
 * tracking began may have been read plenty under the old, uncounted regime;
 * the honest claim is "not read since tracking started on <date>".
 */

import { useState } from 'react';
import { Flame, Snowflake, Copy, Check } from 'lucide-react';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { SegmentedControl, type SegmentedControlItem } from '@/components/ui/SegmentedControl';
import { useReadRanking } from '@/lib/queries/read-ranking';
import { scopeType } from '@/lib/scope';
import type { ReadRankingDirection, ReadRankingEntry } from '@lorekit/schemas/memory';

const DIRECTION_ITEMS: SegmentedControlItem<ReadRankingDirection>[] = [
  { value: 'hot', label: 'Hot', icon: Flame, ariaLabel: 'Most-read lore' },
  { value: 'cold', label: 'Cold', icon: Snowflake, ariaLabel: 'Least-read lore' },
];

function formatCountingSince(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** `scope::key` lines for the groom handoff — the shape `lorekit groom` reads. */
function groomList(entries: readonly ReadRankingEntry[]): string {
  return entries.map((e) => `${e.scope}::${e.key}`).join('\n');
}

export function HotColdLore() {
  const [direction, setDirection] = useState<ReadRankingDirection>('cold');
  const { data, isLoading, isError } = useReadRanking(direction, 20);
  const [copied, setCopied] = useState(false);

  const entries = data?.entries ?? [];

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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl
          label="Ranking direction"
          items={DIRECTION_ITEMS}
          value={direction}
          onChange={setDirection}
          labels="wide"
        />
        {entries.length > 0 && direction === 'cold' && (
          <button
            type="button"
            onClick={handleCopyForGroom}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2.5 py-1.5 text-xs text-[var(--color-content-secondary)] transition-colors duration-150 hover:bg-[var(--color-bg-raised)]"
          >
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy for groom'}
          </button>
        )}
      </div>

      {data && (
        <p className="text-xs text-[var(--color-content-tertiary)]">
          {direction === 'cold'
            ? `Not read since tracking began on ${formatCountingSince(data.counting_since)} — 0 only means unread since this date, not never.`
            : `Most-read lore since tracking began on ${formatCountingSince(data.counting_since)}.`}
        </p>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-2" aria-hidden>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-8 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
          ))}
        </div>
      ) : isError ? (
        // NEVER fold a failed request into the empty state. A 400 on
        // `GET /memories/read-ranking` rendered as "No memories to rank yet."
        // for as long as the route was broken, which read as an empty account
        // rather than a broken panel and hid the defect completely.
        <p className="text-xs text-[var(--color-content-secondary)]">
          Failed to load the read ranking. Please refresh the page to try again.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-[var(--color-content-tertiary)]">No memories to rank yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <HotColdLoreRow key={entry.id} entry={entry} direction={direction} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HotColdLoreRow({ entry, direction }: { entry: ReadRankingEntry; direction: ReadRankingDirection }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2 text-xs">
      <ScopeBadge scope={entry.scope} type={scopeType(entry.scope)} showType={false} label className="shrink-0" />
      <code className="min-w-0 flex-1 truncate font-mono text-[var(--color-content-secondary)]">{entry.key}</code>
      <span className="shrink-0 font-mono text-[var(--color-content-tertiary)]">
        read {entry.read_count}×
        {entry.seen_count != null && ` · written ${entry.seen_count}×`}
      </span>
      {direction === 'hot' && entry.last_read_at && (
        <span className="hidden shrink-0 text-[var(--color-content-tertiary)] sm:inline">
          last {new Date(entry.last_read_at).toLocaleDateString()}
        </span>
      )}
    </li>
  );
}
