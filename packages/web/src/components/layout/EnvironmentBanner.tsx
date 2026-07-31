import { resolveEnvironmentBadge } from '@/lib/environment';

/**
 * Read at module scope on purpose — Next.js inlines the `NEXT_PUBLIC_*` values
 * listed in `next.config.ts` at build time, so this costs nothing at runtime
 * and works in both server and client rendering.
 */
const badge = resolveEnvironmentBadge({
  backendEnv: process.env['NEXT_PUBLIC_BACKEND_ENV'],
  vercelEnv: process.env['NEXT_PUBLIC_VERCEL_ENV'],
  projectRef: process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'],
});

const TONE = {
  preview: {
    stripe: 'bg-[var(--color-warning)]',
    pill: 'border-[var(--color-warning)] bg-[var(--color-accent-subtle)] text-[var(--color-warning)]',
  },
  local: {
    stripe: 'bg-[var(--color-info)]',
    pill: 'border-[var(--color-info)] bg-[var(--color-bg-elevated)] text-[var(--color-info)]',
  },
} as const;

/**
 * A persistent "this is not production" marker.
 *
 * Rendered from the ROOT layout so it is present on the auth pages too — the
 * login screen is exactly where the confusion bites, because a preview build
 * authenticates against the preview Supabase project and your production
 * account simply does not exist there.
 *
 * Deliberately `fixed` + `pointer-events-none`: the dashboard shell is a
 * `h-screen` flex column, so a banner in the normal flow would push the whole
 * app out of the viewport. This overlays instead of reflowing, and never
 * intercepts a click.
 */
export function EnvironmentBanner() {
  if (!badge) return null;

  const tone = TONE[badge.tone];

  return (
    <div
      role="status"
      aria-label={badge.description}
      className="pointer-events-none fixed inset-x-0 top-0 z-[100]"
    >
      {/* Full-width stripe — visible at a glance, even on a screenshot. */}
      <div className={`h-[3px] w-full ${tone.stripe}`} />

      {/* Pill. Top-centre keeps it clear of the bottom-right toast portal. */}
      <div className="flex justify-center">
        <div
          title={badge.description}
          className={`flex items-baseline gap-2 rounded-b-md border border-t-0 px-3 py-1 font-[family-name:var(--font-mono)] text-[10px] leading-none tracking-widest uppercase shadow-lg ${tone.pill}`}
        >
          <span className="font-semibold">{badge.label}</span>
          {badge.detail ? (
            <span className="tracking-normal normal-case opacity-70">{badge.detail}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
