/**
 * LessonCardSkeleton — a loading placeholder shaped exactly like the real
 * `MemoryCard` in `layout="card"` (the Lore Explorer's list). Mirrors the real
 * card's structure so the list does not visually jump when data arrives:
 *
 *   header row  — scope-badge block + org-chip block + title bar + a
 *                 right-aligned timestamp bar (`MemoryCard`'s
 *                 `[scope pill] [org chip] key … timestamp` row)
 *   preview     — a two-line bar (`line-clamp-2` preview paragraph)
 *   chip row    — 3–4 pill placeholders (`MetaChip`/`Tags`)
 *
 * Root matches `MemoryCard`'s card wrapper exactly (`rounded-xl border p-4
 * flex flex-col gap-2`), so this drops into the same list without its own
 * layout wrapper. `animate-pulse` + fixed px widths, mirroring
 * `LoreExplorerSkeleton`'s `CHIP_WIDTHS` convention so the pulse blocks are
 * stable between renders rather than recomputing on every mount.
 *
 * `aria-hidden` — decorative until the data lands, exactly like every other
 * skeleton in this package; the list's own `role="status"`/`aria-label`
 * wrapper (see `LoreExplorer.tsx`) is what announces the loading state to
 * assistive tech.
 *
 * The ONE card skeleton for the whole package — every plain `h-24` box loader
 * (LoreExplorer's `isLoading` branch, its cluster-member loading row, and
 * `LoreExplorerSkeleton`'s `CardsSkeleton`) renders this instead, so a card
 * shape can drift in exactly one place if the real `MemoryCard` ever changes.
 */

const CHIP_WIDTHS = [56, 72, 48, 64];

export function LessonCardSkeleton() {
  return (
    <div
      aria-hidden
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4 flex flex-col gap-2"
    >
      {/* Header row — scope badge, org chip, title bar, right-aligned timestamp. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="h-5 w-20 shrink-0 animate-pulse rounded-full bg-[var(--color-bg-elevated)]" />
        <div className="h-5 w-5 shrink-0 animate-pulse rounded-full bg-[var(--color-bg-elevated)]" />
        <div className="h-4 w-24 shrink-0 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="ml-auto h-3 w-14 shrink-0 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      </div>

      {/* Preview — two lines, matching the real card's `line-clamp-2`. */}
      <div className="flex flex-col gap-1.5">
        <div className="h-3 w-full animate-pulse rounded bg-[var(--color-bg-elevated)]" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--color-bg-elevated)]" />
      </div>

      {/* Chip row — a handful of pill placeholders, fixed widths so the pulse
          blocks are stable between renders. */}
      <div className="flex flex-wrap gap-1">
        {CHIP_WIDTHS.map((w, i) => (
          <div
            key={i}
            className="h-5 shrink-0 animate-pulse rounded-md bg-[var(--color-bg-elevated)]"
            style={{ width: `${w}px` }}
          />
        ))}
      </div>
    </div>
  );
}
