'use client';

/**
 * ScopeConsumption — scopes ranked by memory RECORDS read over the selected
 * window, from the SAME `(bucket, scope, count)` rows `GET /memories/read-activity`
 * already returns (migration 00058). The Explorer and Overview read cards sum
 * this scope axis away and chart only the total; this ranks it instead, so "who
 * is actually reading which lore" — not just "how much was read overall" —
 * becomes answerable on screen.
 *
 * ## The unattributed bucket is shown, not dropped
 *
 * ~40% of read records account-wide carry no scope at all (`null`), almost
 * entirely `memory.search` calls: `usage_events.scope` is one text column and
 * `memory.search` takes a `scopes[]` array, so the recording site
 * (`safeValidateScope`) has nothing single-valued to write (see PR B2, which
 * addresses the cause). Silently omitting that bucket here would make the bars
 * stop summing to the account's read total — the same additive invariant every
 * other stat card on this dashboard holds — so it renders as its own row,
 * honestly labelled, with a tooltip explaining why it exists.
 *
 * Pure ranking lives in `lib/scope-consumption.ts`; this component is the
 * impure shell (fetch + render). Each NAMED row links into the Explorer
 * narrowed to that scope — see {@link ScopeConsumptionRow}.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { ScopeBadge } from '@/components/memory/ScopeBadge';
import { Tooltip } from '@/components/ui/Tooltip';
import { AnimatedNumber } from '@/components/ui/AnimatedNumber';
import { useScopeConsumption } from '@/lib/queries/scope-consumption';
import { scopeType } from '@/lib/scope';

interface ScopeConsumptionProps {
  since: string;
  until: string;
  /** How many named scopes to show before folding the rest into "N more". @default 8 */
  limit?: number;
}

const DEFAULT_LIMIT = 8;

export function ScopeConsumption({ since, until, limit = DEFAULT_LIMIT }: ScopeConsumptionProps) {
  const { data, isLoading } = useScopeConsumption(since, until);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  // "+N more" used to be inert label text with no way to actually see those
  // scopes — this makes the label a toggle instead of a dead end.
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-6 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-xs text-[var(--color-content-tertiary)]">
        No memory reads recorded in this window.
      </p>
    );
  }

  const named = rows.filter((r) => r.scope !== null);
  const unattributed = rows.find((r) => r.scope === null) ?? null;
  const shown = expanded ? named : named.slice(0, limit);
  const hiddenCount = named.length - shown.length;
  // Max against the FULL set (including unattributed), so every bar's width is
  // relative to the same scale — the unattributed bar is often the largest.
  const max = Math.max(...rows.map((r) => r.count), 1);

  return (
    // `@container`, so each row's three-column ⇄ stacked switch keys off the
    // CARD's width rather than the viewport's (see {@link ScopeConsumptionRow}).
    // The card is one column of a page grid, so a wide screen does not imply a
    // wide card — a viewport query would keep the rigid three columns in a
    // narrow card and re-clip the very names this layout exists to show.
    <div className="@container flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
          Scope consumption
        </h3>
        <span className="text-xs text-[var(--color-content-tertiary)]">
          <AnimatedNumber value={total} /> records read
        </span>
      </div>

      {/* Scrollable only once expanded — a leaderboard with 100+ scopes should
          not turn "show more" into "triple the page's scroll length". */}
      <ul className={expanded ? 'flex max-h-96 flex-col gap-2 overflow-y-auto pr-1' : 'flex flex-col gap-2'}>
        {shown.map((row) => (
          <ScopeConsumptionRow key={row.scope} scope={row.scope} count={row.count} max={max} />
        ))}
      </ul>

      {named.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="self-start text-xs text-[var(--color-accent)] hover:underline"
        >
          {expanded ? 'Show fewer scopes' : `Show ${hiddenCount} more scope${hiddenCount === 1 ? '' : 's'}`}
        </button>
      )}

      {/* Always last, regardless of rank, so the "everything you can name" set
          reads before the "attribution gap" row — ranking it by count could
          otherwise put it first and read as the headline finding rather than a
          caveat on the ones above it. */}
      {unattributed && (
        <ul className="flex flex-col gap-2">
          <ScopeConsumptionRow
            scope={null}
            count={unattributed.count}
            max={max}
            tooltip="Records read by a call that could not be attributed to one scope — mostly memory.search, which accepts a list of scopes rather than one. Included so these bars still sum to the total above."
          />
        </ul>
      )}
    </div>
  );
}

function ScopeConsumptionRow({
  scope,
  count,
  max,
  tooltip,
}: {
  scope: string | null;
  count: number;
  max: number;
  tooltip?: string;
}) {
  const widthPct = Math.max((count / max) * 100, 2);
  // Name / bar / count, but WRAPPED rather than three rigid columns.
  //
  // The name column has to be the SAME fixed width on every row or the bars
  // stop sharing a baseline and the chart stops being readable — which is why
  // the name cannot simply size to its content. So the layout buys the name
  // room two different ways depending on how much the card has:
  //
  //  - wide card (`@md` and up): more of that fixed width than the flat 176px
  //    that clipped `lorekit-web-daily-report` mid-word — 224px, and 288px once
  //    the card clears `@2xl`.
  //  - narrow card (below `@md`, i.e. a phone): stop competing for it at all.
  //    `basis-full` drops the bar onto its own line, so the name gets the whole
  //    width instead of a fraction of it, and the `order-*` pairs keep the
  //    count beside the NAME once the bar has moved out from between them.
  //
  // The breakpoints are CONTAINER queries, not `sm:`/`lg:` viewport ones: this
  // card is one column of a page grid, so "wide screen" never implied "wide
  // card", and a viewport query would hold the rigid three columns in a card
  // too narrow for them.
  const body = (
    <>
      <div className="order-1 flex min-w-0 flex-1 items-center gap-1.5 @md:flex-none @md:basis-56 @2xl:basis-72">
        {scope !== null ? (
          <ScopeBadge scope={scope} type={scopeType(scope)} showIcon showType={false} label className="max-w-full truncate" />
        ) : (
          <span className="flex min-w-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-1.5 py-0.5 font-mono text-[var(--color-content-tertiary)]">
            <span className="truncate">unattributed</span>
            {tooltip && (
              <Tooltip content={tooltip} side="top" align="left">
                <Info className="size-3 shrink-0" aria-hidden />
              </Tooltip>
            )}
          </span>
        )}
      </div>
      {/* `data-slot` so the layout tests can find the track: it is decorative,
          so it carries no role or label of its own to query by. */}
      <div
        data-slot="bar"
        className="relative order-3 h-2 w-full min-w-0 basis-full overflow-hidden rounded-full bg-[var(--color-bg-elevated)] @md:order-2 @md:w-auto @md:flex-1 @md:basis-auto"
      >
        <div
          className="h-full rounded-full bg-[var(--color-accent)]"
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className="order-2 w-16 shrink-0 text-right font-mono tabular-nums text-[var(--color-content-secondary)] @md:order-3">
        {count.toLocaleString()}
      </span>
    </>
  );

  // The unattributed row has no scope to filter by, so it stays inert rather
  // than linking somewhere that would silently show a DIFFERENT set of lore
  // than the bar measures.
  if (scope === null) {
    return <li className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">{body}</li>;
  }

  // A named scope links into the Explorer narrowed to it: the leaderboard's
  // finding is "this scope is hot" and the next question is always "what is IN
  // it", which was previously a manual re-selection on another page. `?scope=`
  // is the Explorer's own param — `scope` is deliberately NOT a `?filters=`
  // dimension, so this is the only encoding that works.
  //
  // Hover is `accent-subtle`, not `bg-elevated`: the bar's own track is
  // `bg-elevated`, so that hover would erase the bar it sits under.
  return (
    <li className="text-xs">
      <Link
        href={`/lore?scope=${encodeURIComponent(scope)}`}
        className="-mx-1.5 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-[var(--color-accent-subtle)]"
        title={`Open ${scope} in the Lore Explorer`}
      >
        {body}
      </Link>
    </li>
  );
}
