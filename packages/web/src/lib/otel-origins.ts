/**
 * Single source of truth for the Supabase origin pattern used to decide where
 * W3C trace context (`traceparent`) may be propagated.
 *
 * Two call sites share this pattern and MUST NOT drift:
 *   - `packages/web/src/instrumentation.ts` (Node runtime, server actions / RSC)
 *   - `packages/web/src/lib/dash0-rum.ts`   (browser — the single RUM init path,
 *     reached from both `instrumentation-client.ts` and `Dash0Provider.tsx`)
 *
 * This module is intentionally **dependency-free** (no React, no `next/*`, no
 * node builtins) so it can be evaluated in both the Node runtime and the
 * browser bundle. The env var is read via the literal
 * `process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF']` member expression because
 * Next.js statically inlines `NEXT_PUBLIC_*` reads at build time for the
 * browser bundle — the read must stay a literal, never a computed key.
 */

/**
 * Module-level guard so the "project ref is unset" warning is emitted at most
 * once per process / page load rather than on every call.
 */
let warnedMissingProjectRef = false;

/**
 * Build the regular expression matching the project's Supabase origins
 * (`*.supabase.co` and `*.supabase.in`), for both the PostgREST (`/rest/v1/…`)
 * and Edge Function (`/functions/v1/…`) paths.
 *
 * The pattern is anchored at the start (`^`) so a URL that merely *contains* a
 * Supabase-looking origin later in the string — e.g.
 * `https://evil.com/https://<ref>.supabase.co/x` — is never treated as our
 * Supabase origin. Only `https://` is matched; plain `http://` is excluded so
 * trace context is never propagated over an unencrypted connection.
 *
 * ## Deliberate fail-open when `NEXT_PUBLIC_SUPABASE_PROJECT_REF` is unset
 *
 * When the env var is missing the project-ref segment falls back to `[^.]+`,
 * which widens the pattern to **any** `*.supabase.co` / `*.supabase.in` host.
 * This is a knowingly-accepted fail-open, kept because local development and
 * preview environments frequently run without the var set, and removing the
 * fallback would silently disable trace propagation there (the failure mode we
 * are fixing in the first place). The blast radius is limited: the pattern only
 * ever *permits* attaching a `traceparent` header, it grants no credentials and
 * carries no user data. To make the widening visible rather than silent, a
 * `console.warn` is emitted once per process the first time it happens.
 *
 * Set `NEXT_PUBLIC_SUPABASE_PROJECT_REF` in every deployed environment to keep
 * the pattern narrowed to your own project.
 *
 * @returns a `RegExp` matching this project's Supabase origins.
 */
export function supabaseOriginPattern(): RegExp {
  const projectRef = process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'];

  if (!projectRef) {
    if (!warnedMissingProjectRef) {
      warnedMissingProjectRef = true;
      console.warn(
        '[otel] NEXT_PUBLIC_SUPABASE_PROJECT_REF is not set — trace context will be ' +
          'propagated to ANY *.supabase.co / *.supabase.in host. Set the variable to ' +
          'narrow propagation to this project only.',
      );
    }
    return new RegExp('^https://[^.]+\\.(supabase\\.co|supabase\\.in)/.*');
  }

  return new RegExp(`^https://${escapeRegExp(projectRef)}\\.(supabase\\.co|supabase\\.in)/.*`);
}

/**
 * Escape regex metacharacters so a malformed project ref can never widen or
 * break the pattern. Real Supabase refs are `[a-z]{20}`, so this is purely
 * defensive against a misconfigured env var.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
