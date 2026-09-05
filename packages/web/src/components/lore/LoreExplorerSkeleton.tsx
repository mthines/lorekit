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
//   2. Insights panel   (ExplorerInsights, COLLAPSED) — the Activity header
//      (title + range pill + disclosure chevron) over the four COLLAPSED stat
//      cards, on the panel's own `@container` grid (one-up, two-up from `@sm`,
//      four-up from `@3xl`) exactly as `ExplorerStats` lays them out. The heatmap
//      lives INSIDE this panel and only renders when it is expanded, so — like
//      the real collapsed default — it is not skeletoned here.
//   3. Results          — the ONLY breakpoint-split region, matching the real
//      component's `hidden md:flex` desktop container vs `flex md:hidden` mobile
//      stack. Both show the same control row + card list (the row differing only
//      in the filter trigger's width, as the real one does); scope no longer has
//      a left rail, so the desktop results are a single full-width column.
//
// `SEGMENT` widths are fixed px so the pulse blocks are stable between renders.
const CHIP_WIDTHS = [64, 88, 56, 76, 60, 92];
const CARDS = [0, 1, 2, 3, 4];
const STRIP = [0, 1, 2, 3]; // the four collapsed stat cards

/**
 * The filter control row: search (grows) + the filter trigger + the date pill.
 *
 * TWO controls after the search box, not three. The retention conditions used to
 * have a trigger of their own here; they are now rows inside the filter menu, so
 * a third block would promise a control the loaded page does not have — the
 * placeholder would resolve to a narrower row and shift the date pill sideways.
 *
 * The trigger is the one part that is not the same on both breakpoints: it reads
 * "Filter" on desktop and collapses to an icon (plus a count badge) on mobile,
 * so the skeleton splits the same way the real control row does.
 */
function ControlRowSkeleton({ variant }: { variant: 'desktop' | 'mobile' }) {
  return (
    // `data-testid` because the whole skeleton is `aria-hidden` (it is decorative
    // until the data lands), so its own test has no role to query it by.
    <div data-testid="control-row" className="flex items-center gap-2">
      <div className="h-9 flex-1 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
      <div
        className={[
          'h-9 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]',
          variant === 'desktop' ? 'w-20' : 'w-9',
        ].join(' ')}
      />
      <div className="h-9 w-24 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
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

      {/* 2. Insights panel (collapsed): the Activity header + the four COLLAPSED
             stat cards, in the same bordered section the real panel uses so the
             height matches. The cards mirror `CollapsibleStatCard`'s collapsed
             density exactly — each is its own `rounded-xl border … p-4` tile with
             the icon left of the number and the label beneath — laid out on the
             same `ExplorerStats` grid (one-up, two-up from `@sm`, four-up from
             `@3xl`, sized to the PANEL via `@container`, not the viewport). A
             flat four-number strip here is what made the panel jump on first
             paint. */}
      <div
        aria-hidden
        className="@container rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
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
          {/* Collapsed cards: four bordered tiles on the real grid. */}
          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-4">
            {STRIP.map((i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4"
              >
                {/* Icon box, left of the number — the real card's `size-9` tile. */}
                <div className="size-9 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
                <div className="min-w-0 flex-1">
                  <div className="h-6 w-12 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
                  <div className="mt-1 h-3 w-20 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
                </div>
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
          <ControlRowSkeleton variant="desktop" />
        </div>
        <div className="p-3">
          <CardsSkeleton />
        </div>
      </div>

      {/* Mobile: looser stack — control row, then the card list (pb-6 so the last
          card clears the bottom edge, matching the real layout). */}
      <div aria-hidden className="flex flex-col gap-3 pb-6 md:hidden">
        <ControlRowSkeleton variant="mobile" />
        <CardsSkeleton />
      </div>
    </div>
  );
}
