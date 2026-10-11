/**
 * The amber aurora + grid wash behind the public pages.
 *
 * Purely decorative (`aria-hidden`, `pointer-events-none`) and shared by `/`
 * and `/login` so the two never drift into two different-looking front doors.
 * Static by design: a moving gradient behind a whole page is the one background
 * effect that reliably costs paint frames on a low-end laptop, and it competes
 * with the entrance motion the content itself carries. `fixed` keeps it on its
 * own composited layer, so scrolling never repaints it.
 *
 * Colours come from the theme tokens — the amber is the brand accent and the
 * violet is the `global` scope colour — so a palette change reaches the
 * backdrop instead of leaving two hard-coded hexes behind.
 *
 * The grid is masked to fade out from the top centre: an even grid across the
 * whole viewport reads as graph paper, while one that dissolves behind the
 * headline reads as light falling on it.
 */
export function LandingBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      {/* Top beam — the brightest point sits just above the headline. */}
      <div
        className="absolute left-1/2 top-0 h-[520px] w-[1100px] -translate-x-1/2 -translate-y-1/3 rounded-full opacity-25 blur-3xl"
        style={{
          background:
            'radial-gradient(closest-side, var(--color-accent), color-mix(in srgb, var(--color-accent) 30%, transparent) 55%, transparent)',
        }}
      />
      <div
        className="absolute left-1/2 top-1/3 size-[760px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.12]"
        style={{ background: 'radial-gradient(circle, var(--color-accent) 0%, transparent 70%)' }}
      />
      <div
        className="absolute bottom-0 right-0 size-[560px] translate-x-1/4 translate-y-1/4 rounded-full opacity-10"
        style={{ background: 'radial-gradient(circle, var(--color-scope-global) 0%, transparent 70%)' }}
      />
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          maskImage: 'radial-gradient(ellipse 70% 55% at 50% 0%, black 30%, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 55% at 50% 0%, black 30%, transparent 100%)',
        }}
      />
    </div>
  );
}
