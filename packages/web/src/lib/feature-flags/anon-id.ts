/**
 * Stable, per-browser targeting key for feature-flag bucketing — the cookie
 * counterpart to `lib/anonymous-id.ts`'s `localStorage` visitor id.
 *
 * ## Why a SEPARATE id from the RUM one, in a SEPARATE cookie
 *
 * `lib/anonymous-id.ts` is `localStorage`-backed, which only the BROWSER can
 * read — a Server Component rendering before any client JS runs has no access
 * to it. Feature-flag bucketing needs the opposite: the id must be readable
 * by the SERVER on the very first request, because `@lorekit/feature-flags`'
 * `LoreKitFlagProvider.resolveBooleanEvaluation` runs server-side (Server
 * Components, Server Actions) and needs a `targetingKey` at evaluation time —
 * not after a client round-trip. A cookie, minted once in `middleware.ts` and
 * sent with every subsequent request, is the one identity primitive both the
 * server (via `next/headers`) and, if ever needed, the browser can read.
 *
 * Kept **`httpOnly`**, unlike a typical client-readable id cookie: nothing in
 * this app reads it from `document.cookie` — a Client Component gets its flag
 * VALUES from the server via `FeatureFlagsProvider` (see `client.tsx`), never
 * by re-deriving the targeting key and re-evaluating independently. That is
 * also what keeps server and client from ever disagreeing on a flag's value
 * (see `context-client-vs-server` note in `client.tsx`).
 *
 * This module fixes the "same bucket forever" gap flagged in `provider.ts`'s
 * `ANONYMOUS_TARGETING_KEY` fallback: an authenticated dashboard user's
 * `targetingKey` is their Supabase user id (see `server.ts`), but the
 * fallback for a visitor with no session yet — mid-signup, before the first
 * `auth.getUser()` succeeds — needs a targeting key too, and "anonymous" the
 * literal string is exactly the bug. This cookie is that targeting key.
 */
import { cookies } from 'next/headers';
import { mintAnonymousId } from '@/lib/anonymous-id';

export const FLAG_ANON_ID_COOKIE = 'lorekit_flag_anon_id';

/** One year — long-lived, like the visitor id it stands in for. Re-minted if ever absent. */
const FLAG_ANON_ID_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Ensure the request carries a flag-targeting anonymous id, minting one if
 * absent. Called from `middleware.ts` on every request (cheap — a cookie
 * read plus, at most once per browser, a cookie write) so that by the time
 * any Server Component runs, `readFlagAnonId()` never has to mint on the
 * read path — reads must be synchronous with respect to `cookies()`, which
 * cannot be mutated from a plain Server Component render.
 */
export function ensureFlagAnonIdCookie(
  requestCookies: { get(name: string): { value: string } | undefined },
  responseCookies: {
    set(name: string, value: string, options?: Record<string, unknown>): void;
  },
): void {
  if (requestCookies.get(FLAG_ANON_ID_COOKIE)) return;
  responseCookies.set(FLAG_ANON_ID_COOKIE, mintAnonymousId(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: FLAG_ANON_ID_MAX_AGE_SECONDS,
    path: '/',
  });
}

/**
 * Read the flag-targeting anonymous id from the current request's cookies.
 *
 * Returns `undefined` on the — expected to be rare — request where
 * `middleware.ts` has not run yet (e.g. certain prefetches) rather than
 * minting one here: minting requires WRITING a cookie, which a read-only
 * Server Component context cannot do. `resolveFeatureFlagContext` (`server.ts`)
 * treats an absent id the same as an absent session — falls through to
 * `LoreKitFlagProvider`'s own last-resort constant, with its dev-mode warning
 * intact as the signal that something upstream isn't wired correctly.
 */
export async function readFlagAnonId(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(FLAG_ANON_ID_COOKIE)?.value;
}
