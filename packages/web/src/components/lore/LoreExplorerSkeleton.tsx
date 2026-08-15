// Skeleton for the data-only part of the Lore Explorer.
// Used by lore/page.tsx inline (so the title stays visible while data loads)
// and by lore/loading.tsx (route-level fallback on first navigation).
//
// It mirrors the real LoreExplorer top-to-bottom so the placeholder resolves to
// the same shape the data will, with no layout jump:
//
//   1. Scope chip row   (ScopeSelector)   — ONE shape on both breakpoints. The
//      real selector is a single horizontal chip strip + a pinned "Browse all",
//      not a breakpoint-split sidebar/accordion, so the skeleton is unified too.
//   2. Insights panel   (ExplorerInsights, COLLAPSED) — also one shape on both:
//      the Activity header (title + range pill + disclosure chevron) and the
//      collapsed four-number strip. The heatmap lives INSIDE this panel and only
//      renders when it is expanded, so — like the real collapsed default — it is
//      not skeletoned here.
//   3. Results          — the ONLY breakpoint-split region, matching the real
//      component's `hidden md:flex` desktop container vs `flex md:hidden` mobile
//      stack. Both show the same control row + card list; scope no longer has a
//      left rail, so the desktop results are a single full-width column.
//
// `SEGMENT` widths are fixed px so the pulse blocks are stable between renders.
const CHIP_WIDTHS = [64, 88, 56, 76, 60, 92];
const CARDS = [0, 1, 2, 3, 4];
const STRIP = [0, 1, 2, 3];

/** The filter control row — identical on both breakpoints, as the real one is:
 *  search (grows) + filter trigger + date pill + status pill. */
function ControlRowSkeleton() {
  return (
    <div className="flex items-center gap-2">
      <div className="h-9 flex-1 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
      <div className="size-9 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
      <div className="h-9 w-20 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
      <div className="h-9 w-14 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
    </div>
  );
}

/** The memory card list — same card shape on both breakpoints. */
function CardsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {CARDS.map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
        />
      ))}
    </div>
  );
}

export function LoreExplorerSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {/* 1. Scope chip row — rounded-full chips (min-h-7 matches the real ones) +
             a pinned "Browse all" pill. One shape on every breakpoint. */}
      <div aria-hidden className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {CHIP_WIDTHS.map((w, i) => (
            <div
              key={i}
              className="h-7 shrink-0 animate-pulse rounded-full bg-[var(--color-bg-elevated)]"
              style={{ width: `${w}px` }}
            />
          ))}
        </div>
        <div className="h-7 w-16 shrink-0 animate-pulse rounded-full bg-[var(--color-bg-elevated)]" />
      </div>

      {/* 2. Insights panel (collapsed): the Activity header + the four-number
             strip, in the same bordered section the real panel uses so the height
             matches. */}
      <div
        aria-hidden
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
      >
        <div className="flex flex-col gap-2 px-4 py-3">
          {/* Header row: title + range pill + disclosure chevron. */}
          <div className="flex items-center gap-3">
            <div className="h-3 w-28 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
            <div className="ml-auto flex items-center gap-2">
              <div className="h-6 w-32 animate-pulse rounded-md bg-[var(--color-bg-elevated)]" />
              <div className="size-6 animate-pulse rounded-lg bg-[var(--color-bg-elevated)]" />
            </div>
          </div>
          {/* Collapsed strip: four icon + number + label groups on one line. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {STRIP.map((i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="size-3.5 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
                <div className="h-4 w-8 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
                <div className="h-3 w-12 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 3. Results — the one breakpoint-split region, mirroring the real
             component's `hidden md:flex` / `flex md:hidden` split. */}

      {/* Desktop: bordered container, control row over the card list. */}
      <div
        aria-hidden
        className="hidden overflow-hidden rounded-xl border border-[var(--color-border)] md:flex md:flex-col"
      >
        <div className="border-b border-[var(--color-border)] p-3">
          <ControlRowSkeleton />
        </div>
        <div className="p-3">
          <CardsSkeleton />
        </div>
      </div>

      {/* Mobile: looser stack — control row, then the card list (pb-6 so the last
          card clears the bottom edge, matching the real layout). */}
      <div aria-hidden className="flex flex-col gap-3 pb-6 md:hidden">
        <ControlRowSkeleton />
        <CardsSkeleton />
      </div>
    </div>
  );
}
