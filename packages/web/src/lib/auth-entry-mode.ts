/**
 * Which door a visitor came through to `/login`: to sign in, or to sign up.
 *
 * `/login` serves both, but it used to speak only of signing in — heading,
 * buttons and the email form's default all said "Sign in". Every "Get a token"
 * and "Create a free account" CTA on the site landed there, and RUM showed what
 * that cost: in the 30 days to 2026-11-08, 44 of 56 real visitors to `/login`
 * left without choosing any option, and of the 4 who opened the email form, none
 * submitted it. Only one found the small "Create an account" link at all.
 *
 * The fix is to let the link carry the intent (`/login?mode=signup`) so the page
 * can greet a newcomer as one. This parser is the one place that reading lives.
 */
export type AuthEntryMode = 'signin' | 'signup';

/** The query parameter that carries the mode. */
export const AUTH_ENTRY_MODE_PARAM = 'mode';

/** The sign-up entry URL. Every "create an account" CTA links here. */
export const SIGNUP_PATH = `/login?${AUTH_ENTRY_MODE_PARAM}=signup`;

/**
 * Read the mode from a raw query value. Anything other than exactly `signup`
 * is `signin` — the safe default for a returning user and for every existing
 * `/login?next=…` redirect, which carries no mode.
 *
 * Accepts the `string | string[] | undefined` shape Next's `searchParams` uses,
 * as well as `URLSearchParams.get`'s `string | null`. Total — never throws.
 */
export function parseAuthEntryMode(value: string | string[] | null | undefined): AuthEntryMode {
  const first = Array.isArray(value) ? value[0] : value;
  return first === 'signup' ? 'signup' : 'signin';
}

/**
 * The `/login` URL for a mode, carrying `next` through so a visitor who
 * switches between "sign in" and "create an account" still lands where the
 * redirect that brought them meant to send them.
 */
export function authEntryHref(mode: AuthEntryMode, next?: string | string[] | null): string {
  const params = new URLSearchParams();
  if (mode === 'signup') params.set(AUTH_ENTRY_MODE_PARAM, 'signup');
  const nextValue = Array.isArray(next) ? next[0] : next;
  if (nextValue) params.set('next', nextValue);
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}
