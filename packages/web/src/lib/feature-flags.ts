/**
 * Client-visible feature flags — one literal `process.env['NEXT_PUBLIC_…']`
 * member expression per flag so Next.js can inline each at build time (the
 * `github-app-url.ts` pattern; a computed lookup like `process.env[name]`
 * would not be inlined and would silently read `undefined` at runtime).
 */

/**
 * Retention policies ("grooming") — Settings → Grooming and its nav entry.
 * Gates the UI only: the backend enforces its own `LOREKIT_RETENTION_POLICIES_ENABLED`
 * (a Supabase secret the web app cannot read; see `mcp/tools.ts` and
 * `memories/handlers/{groom,policies,protect}.ts`), so flipping this on ahead
 * of that flag would show a page whose calls the backend still rejects. Set
 * the backend flag first, same ordering the GitHub App slug/flag pair uses.
 */
export function retentionPoliciesEnabled(): boolean {
  return process.env['NEXT_PUBLIC_LOREKIT_RETENTION_POLICIES_ENABLED'] === 'true';
}
