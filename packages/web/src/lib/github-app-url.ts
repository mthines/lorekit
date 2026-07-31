/**
 * Resolve the public "install this GitHub App" URL from the App's slug.
 *
 * A GitHub App's public installation page is always
 *   https://github.com/apps/<slug>/installations/new
 * where <slug> is the App's URL-safe name (public — it appears in the URL any
 * installer sees). We read it from NEXT_PUBLIC_GITHUB_APP_SLUG via a literal
 * member expression so Next.js can inline it at build time (the otel-origins.ts
 * pattern).
 *
 * Returns null when the slug is unset — the App is not registered yet, so the
 * UI falls back to the docs-runbook note instead of linking to a dead page.
 *
 * Ordering caveat: webhook coverage also requires `GITHUB_APP_ENABLED=true`, a
 * Supabase secret the web app cannot read. Set this slug only after that flag
 * is on; otherwise the button offers an install the backend silently ignores.
 * The runbook (docs/github-app.md) sequences the flag before the slug for this
 * reason.
 */
export function resolveGithubAppInstallUrl(): string | null {
  const slug = process.env['NEXT_PUBLIC_GITHUB_APP_SLUG']?.trim();
  if (!slug) return null;
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
