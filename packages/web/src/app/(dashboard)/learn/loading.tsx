// Route-level loading fallback for all Learn sub-pages. The layout (header +
// LearnNav sidebar) renders from the RSC immediately; only the content pane
// shows this skeleton while the sub-page resolves.
//
// Shape matches the TutorialCard shell — same border/bg/radius — with shimmer
// rows that approximate a tutorial page's title + step structure. This prevents
// a blank content column and avoids layout shift when the real content lands.
//
// Animation rationale (/animations perceived-performance rules):
//   - Expected wait: < 300 ms for static RSC pages (no data fetching).
//   - Pattern: skeleton matching the content shape, 200 ms-floored by Next.js
//     streaming. Static skeleton (no pulse) because the wait is short.
//   - Cross-fade: Next.js handles the skeleton → page swap; no extra JS needed.
//   - prefers-reduced-motion: Tailwind's animate-pulse is opacity-only, safe.
//     The shimmer pseudo-element is gated in global CSS (see globals.css or
//     inline via the Tailwind class).

export default function LearnLoading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]"
    >
      <div className="p-6">
        {/* Page title + subtitle */}
        <div className="mb-6 flex flex-col gap-2">
          <div className="h-5 w-48 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
          <div className="h-3.5 w-80 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        </div>

        {/* Step rows — 3 numbered steps, each with a title and a body block */}
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-4 pb-8">
            {/* Step number circle */}
            <div className="flex shrink-0 flex-col items-center">
              <div className="size-7 animate-pulse rounded-full bg-[var(--color-bg-elevated)]" />
            </div>
            <div className="min-w-0 flex-1 flex flex-col gap-2">
              {/* Step title */}
              <div className="h-3.5 w-40 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
              {/* Step body lines */}
              <div className="h-3 w-full animate-pulse rounded bg-[var(--color-bg-elevated)]" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
              <div className="h-3 w-4/6 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
              {/* Code block placeholder */}
              {i === 1 && (
                <div className="mt-2 h-20 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
