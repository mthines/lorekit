/**
 * Pure post-login redirect-target validator.
 *
 * The `?next=` parameter is attacker-controllable (it travels through the
 * login page and the OAuth callback), so every consumer must sanitise it
 * before handing it to a redirect. This is the single source of truth for
 * that rule — the auth callback route and the client-side password sign-in
 * both call it, so they can never drift into two different definitions of
 * "safe".
 *
 * Accepts only same-origin absolute paths: a leading `/` but not `//`
 * (scheme-relative URLs such as `//evil.com` are followed by browsers as an
 * absolute URL and are an open-redirect vector), and not `/\` (which some
 * browsers normalise to `//`). Anything else falls back to `/overview`.
 */

export const DEFAULT_POST_LOGIN_PATH = '/overview';

export function safeNextPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_POST_LOGIN_PATH,
): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.startsWith('//')) return fallback;
  if (raw.startsWith('/\\')) return fallback;
  return raw;
}
