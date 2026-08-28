/**
 * Retention policies ("grooming") — gates Settings → Grooming and its nav
 * entry via one literal `process.env['NEXT_PUBLIC_…']` member expression so
 * Next.js can inline it at build time (the `github-app-url.ts` pattern; a
 * computed lookup like `process.env[name]` would not be inlined and would
 * silently read `undefined` at runtime).
 *
 * NOT part of the `@lorekit/feature-flags` (OpenFeature) system in
 * `lib/feature-flags/` — that framework landed on `main` after this flag was
 * added and this is a plain on/off env-var switch with no experiment,
 * targeting, or override needs, so migrating it is a follow-up, not a
 * requirement of adding it. Named to avoid colliding with that directory
 * (`@/lib/feature-flags/*`), not to compete with it.
 *
 * Gates the UI only: the backend enforces its own `LOREKIT_RETENTION_POLICIES_ENABLED`
 * (a Supabase secret the web app cannot read; see `mcp/tools.ts` and
 * `memories/handlers/{groom,policies,protect}.ts`), so flipping this on ahead
 * of that flag would show a page whose calls the backend still rejects. Set
 * the backend flag first, same ordering the GitHub App slug/flag pair uses.
 */
export function retentionPoliciesEnabled(): boolean {
  return process.env['NEXT_PUBLIC_LOREKIT_RETENTION_POLICIES_ENABLED'] === 'true';
}
