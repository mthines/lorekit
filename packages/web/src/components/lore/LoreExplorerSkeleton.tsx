// Skeleton for the data-only part of the Lore Explorer.
// Used by lore/page.tsx inline (so the title stays visible while data loads)
// and by lore/loading.tsx (route-level fallback on first navigation).
//
// The shape is breakpoint-split the same way LoreExplorer itself is: the
// desktop skeleton mirrors the `hidden md:flex` side-by-side panels (scope
// sidebar + list), and the mobile skeleton mirrors the `flex md:hidden` stacked
// layout (collapsed scope header + control row + card list). The split is CSS
// only (`hidden md:flex` / `flex md:hidden`) — matching the real component — so
// the loading placeholder always resolves to the same shape the data will, and
// there is no layout jump when the query settles on either breakpoint.
export function LoreExplorerSkeleton() {
  return (
    <>
      {/* Desktop: side-by-side panels (mirrors LoreExplorer's `hidden md:flex`) */}
      <div
        className="hidden overflow-hidden rounded-xl border border-[var(--color-border)] md:flex"
        style={{ height: 'calc(100vh - 11rem)' }}
      >
        {/* Scope tree skeleton */}
        <div className="flex w-56 shrink-0 flex-col gap-1.5 border-r border-[var(--color-border)] bg-[var(--color-bg-raised)] p-3">
          <div className="mb-2 h-3 w-16 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
          {[60, 75, 90, 70, 85, 65, 80, 60].map((w, i) => (
            <div
              key={i}
              className="h-7 animate-pulse rounded-md bg-[var(--color-bg-elevated)]"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>

        {/* Lesson list skeleton */}
        <div className="flex flex-1 flex-col gap-0 overflow-hidden">
          {/* Search bar */}
          <div className="border-b border-[var(--color-border)] p-3">
            <div className="h-8 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]" />
          </div>
          {/* Cards */}
          <div className="flex flex-col gap-2 overflow-hidden p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
            ))}
          </div>
        </div>
      </div>

      {/* Mobile: stacked layout (mirrors LoreExplorer's `flex md:hidden`) — a
          collapsed scope header, the control row, then the card list. `pb-6`
          matches the real layout so the last card clears the bottom edge. */}
      <div className="flex flex-col gap-3 pb-6 md:hidden">
        {/* Collapsed scope accordion header — `min-h-11` matches the real
            collapsed scope button (44px) so there is no residual height shift. */}
        <div className="flex min-h-11 items-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-4 py-2.5">
          <div className="h-5 w-40 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        </div>

        {/* Control row: search input + filter trigger + date pill + archived
            toggle. The middle placeholder is a wider pill, not a square: the
            real DateRangePicker renders a text pill ("All time"), so a square
            here would let the row shift on load. */}
        <div className="flex items-center gap-2">
          <div className="h-9 flex-1 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          <div className="size-9 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
          <div className="h-9 w-20 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
          <div className="size-9 shrink-0 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
        </div>

        {/* Card list */}
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]" />
          ))}
        </div>
      </div>
    </>
  );
}
