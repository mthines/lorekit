/**
 * Lifetime of the Supabase auth cookies the middleware writes.
 *
 * Dependency-free on purpose: the edge middleware imports it, and the edge
 * bundle must not pull in Node-only modules.
 */

/**
 * 7 days. This is how long a browser can go without a server-side session
 * refresh before the auth cookies expire and the user is signed out. Every
 * refresh re-issues the cookies with a fresh max-age, so the window slides with
 * use: someone who opens the dashboard at least once a week stays signed in.
 *
 * It must stay longer than the access token's `jwt_expiry` (1 h on the hosted
 * project, 24 h in `supabase/config.toml`), so the refresh token is still in
 * the cookie when the access token runs out.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/**
 * The max-age to write for one auth cookie, given the max-age supabase-ssr
 * asked for.
 *
 * supabase-ssr deletes a cookie by writing it empty with `maxAge: 0` (on sign
 * out, and when a session cookie is re-chunked). That deletion has to pass
 * through unchanged; overriding it would leave empty auth cookies in the
 * browser for the whole session window.
 */
export function sessionCookieMaxAge(requestedMaxAge: number | undefined): number {
  if (requestedMaxAge === 0) return 0;
  return SESSION_MAX_AGE_SECONDS;
}
