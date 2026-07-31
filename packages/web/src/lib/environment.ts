/**
 * Which environment is this build talking to?
 *
 * Two independent axes matter here, and conflating them is exactly the mistake
 * this helper exists to prevent:
 *
 *   1. WHERE the frontend runs  — Vercel's `VERCEL_ENV`
 *      (exposed as NEXT_PUBLIC_VERCEL_ENV in next.config.ts).
 *   2. WHICH backend it talks to — the Supabase project the bundle was built
 *      against (exposed as NEXT_PUBLIC_BACKEND_ENV + NEXT_PUBLIC_SUPABASE_PROJECT_REF).
 *
 * They can disagree. `.github/workflows/preview.yml` builds a Vercel *preview*
 * deployment but rewrites `.vercel/.env.preview.local` to point at the
 * **preview Supabase project** — a different database, different auth users,
 * different edge functions than a push-triggered Vercel preview, which keeps
 * whatever Supabase vars the Vercel project has configured. Someone looking at
 * the page cannot tell the two apart, which is what makes "I tested it on the
 * preview URL" ambiguous.
 *
 * So the badge reports the BACKEND first and falls back to the frontend
 * environment only when the backend was not explicitly tagged.
 */

export type EnvironmentTone = 'preview' | 'local';

export interface EnvironmentBadge {
  /** Short, shouty label — e.g. `PREVIEW BACKEND`. */
  label: string;
  /** Secondary line: which Supabase project the bundle points at. */
  detail: string | null;
  /** Longer description used as the accessible label / tooltip. */
  description: string;
  tone: EnvironmentTone;
}

export interface EnvironmentInput {
  /** NEXT_PUBLIC_BACKEND_ENV — set explicitly by the deploy workflow. */
  backendEnv?: string | undefined;
  /**
   * NEXT_PUBLIC_VERCEL_ENV — 'production' | 'preview' | 'development' | ''.
   * Vercel sets 'development' for `vercel dev`; plain `next dev` leaves it
   * empty. Both are local, and both must still be marked.
   */
  vercelEnv?: string | undefined;
  /** NEXT_PUBLIC_SUPABASE_PROJECT_REF — the Supabase project the build targets. */
  projectRef?: string | undefined;
}

const normalise = (value: string | undefined) => (value ?? '').trim().toLowerCase();

/**
 * Returns the badge to show, or `null` when this is a plain production build
 * (production frontend + production backend) — the only case that must render
 * nothing at all.
 */
export function resolveEnvironmentBadge(input: EnvironmentInput): EnvironmentBadge | null {
  const backendEnv = normalise(input.backendEnv);
  const vercelEnv = normalise(input.vercelEnv);
  const projectRef = (input.projectRef ?? '').trim();
  const detail = projectRef ? `supabase · ${projectRef}` : null;

  // 1. The backend was explicitly tagged by the deploy workflow. This wins:
  //    it is the only signal that survives a production-looking frontend
  //    pointed at a non-production database.
  if (backendEnv && backendEnv !== 'production') {
    const label = backendEnv === 'preview' ? 'PREVIEW BACKEND' : `${backendEnv.toUpperCase()} BACKEND`;
    return {
      label,
      detail,
      description: `This build talks to the ${backendEnv} Supabase project — not production data.`,
      tone: 'preview',
    };
  }

  // 2. No explicit backend tag. Fall back to where the frontend is deployed.
  if (backendEnv !== 'production' && vercelEnv === 'preview') {
    return {
      label: 'PREVIEW DEPLOY',
      detail,
      description:
        'Preview deployment. The backend was not tagged, so it may point at the production Supabase project.',
      tone: 'preview',
    };
  }

  // 3. Untagged backend and no deployed frontend environment. `vercel dev`
  //    reports 'development' where plain `next dev` reports nothing; both are
  //    local, and leaving 'development' unhandled would fall through to `null`
  //    — a non-production build silently rendering as if it were production.
  if (!backendEnv && (!vercelEnv || vercelEnv === 'development')) {
    return {
      label: 'LOCAL',
      detail,
      description: 'Local development build.',
      tone: 'local',
    };
  }

  // Production frontend + production (or untagged-but-production) backend.
  return null;
}
