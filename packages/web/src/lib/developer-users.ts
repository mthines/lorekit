/**
 * The developer allowlist behind the hidden `/settings/developer` page in
 * PRODUCTION.
 *
 * Outside production the page is reachable by anyone signed in — see
 * `SettingsNav.tsx`'s environment check and `docs/feature-flags.md` §
 * "Why session overrides gate on environment, not role" for why that's an
 * accepted, self-limited blast radius (an override only ever changes what
 * YOUR OWN session sees). In production, "anyone signed in" is the wrong
 * bar — a customer should never stumble onto flag-override tooling — so
 * this is the one real access-control boundary: an explicit, hand-maintained
 * email allowlist, checked server-side (`app/(dashboard)/settings/developer/page.tsx`)
 * and mirrored client-side only to gate the reveal gesture
 * (`UserSettingsPanel.tsx` / `SettingsNav.tsx`) — the CLIENT check is a UX
 * nicety (don't even track clicks for someone it can never affect), never
 * the actual gate. `notFound()` on the page is what a non-developer
 * production visitor actually hits.
 *
 * Dependency-free (no `next/*`, no Supabase types) so it is safe to import
 * from both a Server Component and a Client Component without dragging
 * either runtime's SDK into the other's bundle.
 */

/** Lowercased. Add an email here to grant it `/settings/developer` access in production. */
export const DEVELOPER_EMAILS: readonly string[] = ['madsthines@gmail.com'];

/** Case-insensitive — email comparison is effectively always case-insensitive in practice. */
export function isDeveloperEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && DEVELOPER_EMAILS.includes(email.toLowerCase());
}
