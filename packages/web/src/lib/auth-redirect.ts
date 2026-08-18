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

/**
 * The largest `pathname + search` this app will carry through the
 * unauthenticated → login → callback → original-URL round trip.
 *
 * A budget, not a preference. The Explorer's filter bar is URL-backed by
 * design — "a filtered view is a link" — and `?filters=` holds a
 * JSON-serialised array whose length grows with the bar, roughly 36 characters
 * per selected value once `URLSearchParams` percent-encodes the quotes and
 * braces. At 200 selected values that param alone is ~7.5 KB, and `?next=`
 * percent-encodes the whole target a second time on top of that.
 *
 * Past the budget, the round trip drops the query string and returns the user
 * to the bare page rather than to a request line nobody can serve. 2 KB leaves
 * ample room for every other header while covering any bar a person assembles
 * by hand.
 *
 * This bounds the RETURN TRIP only. It deliberately does not truncate the
 * address bar itself: a link someone pasted must keep working, and the read
 * path for it is the client — which has no header limit.
 */
export const MAX_RETURN_TO_CHARS = 2048;

/**
 * The path to come back to after login, dropped to the bare pathname when
 * carrying its query string would blow the header budget.
 *
 * Losing a filter bar on a session that had already lapsed is a small, visible
 * degradation. A 431 is an invisible one.
 */
export function boundedReturnTo(pathname: string, search: string): string {
  const full = `${pathname}${search}`;
  return full.length <= MAX_RETURN_TO_CHARS ? full : pathname;
}
