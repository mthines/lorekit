/**
 * Shared construction of the `/api/auth/callback` URL every browser-side auth
 * entry point hands to Supabase (`redirectTo` / `emailRedirectTo`).
 *
 * Split into a pure builder (unit-tested) and a thin browser shell that
 * resolves the origin, so the sign-in form, the magic-link form, the
 * forgot-password page, and the settings password panel all produce the exact
 * same URL shape.
 */

import { safeNextPath } from './auth-redirect';

/**
 * Build the absolute auth-callback URL for `base`, optionally threading a
 * post-login `next` path through it.
 *
 * `next` is sanitised with the same `safeNextPath` the callback route applies,
 * so an attacker-supplied `?next=//evil.com` can never leave the origin — even
 * if a future callback change forgot to re-check it.
 */
export function buildAuthCallbackUrl(base: string, next?: string | null): string {
  const url = new URL('/api/auth/callback', base);
  if (next) url.searchParams.set('next', safeNextPath(next));
  return url.toString();
}

/**
 * Resolve the origin the callback should return to.
 *
 * Prefers the build-time `NEXT_PUBLIC_VERCEL_URL` (set in `next.config.ts`) so
 * preview deployments redirect back to their own URL rather than production;
 * falls back to `window.location.origin` for local dev, which makes any
 * dev-server port work without hardcoding one.
 *
 * Browser-only — callers must be client components.
 */
export function authCallbackOrigin(): string {
  return process.env['NEXT_PUBLIC_VERCEL_URL'] || window.location.origin;
}
