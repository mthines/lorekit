/**
 * The amber halo + grid wash behind the public pages.
 *
 * Purely decorative (`aria-hidden`, `pointer-events-none`) and shared by `/`
 * and `/login` so the two never drift into two different-looking front doors.
 * Static by design: a moving gradient behind a whole page is the one background
 * effect that reliably costs paint frames on a low-end laptop, and it competes
 * with the entrance motion the content itself carries.
 */
export function LandingBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      <div
        className="absolute left-1/2 top-1/3 size-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-30"
        style={{ background: 'radial-gradient(circle, #f5a623 0%, transparent 70%)' }}
      />
      <div
        className="absolute bottom-0 right-0 size-[500px] translate-x-1/4 translate-y-1/4 rounded-full opacity-10"
        style={{ background: 'radial-gradient(circle, #a78bfa 0%, transparent 70%)' }}
      />
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
    </div>
  );
}
