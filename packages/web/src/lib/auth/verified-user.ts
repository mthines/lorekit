/**
 * Request-scoped, cached resolution of the caller's verified Supabase user.
 *
 * `supabase.auth.getUser()` round-trips to Supabase Auth's `/auth/v1/user`
 * endpoint to cryptographically verify the JWT server-side (unlike
 * `getSession()`, which trusts the cookie). That network call used to be
 * repeated independently across the dashboard's server render tree — the
 * layout, several `/settings/*` pages, and roughly a dozen `lib/*.ts` server
 * actions (`orgs.ts`, `org-members.ts`, `org-invites.ts`, `scope-bindings.ts`,
 * `tokens.ts`, `github-installations.ts`, `audit-log.ts`, `plan.ts`,
 * `session-token.ts`) each called it for the SAME request's session.
 *
 * Under normal Auth latency (sub-200ms) that only wasted a few redundant
 * round trips per page. Under an upstream Supabase Auth latency spike it
 * compounds N-fold: a single slow `auth/v1/user` response, awaited serially
 * N times across one render tree, turns into N times that latency for the
 * page as a whole. Observed in production: `GET /overview`'s p95 exceeded
 * 166s (normal baseline ~1.7s) while Supabase Auth was responding in
 * 12-52s per call — a single render calling `getUser()` more than once
 * multiplied that delay instead of paying it once.
 *
 * `getServerFlag`/`getAllServerFlags` (`lib/feature-flags/server.ts`) already
 * solved this ad hoc via a `knownUserId` parameter threaded through from the
 * layout. This generalizes the same fix — React's `cache()` — into one
 * shared helper so every call site collapses onto a SINGLE `auth.getUser()`
 * round trip per request, without each caller needing to thread an id
 * through by hand.
 *
 * `cache()` dedupes only within one request's React render — Server
 * Components, and any `'use server'` action invoked directly from that
 * render — per Next.js's request memoization model. It does NOT extend to
 * Route Handlers, Middleware, or a Server Action invoked as its own
 * separate request (e.g. a client-side form submission). Those call sites
 * (`middleware.ts`, Route Handlers under `app/api/`) keep their own
 * `supabase.auth.getUser()` call.
 */
import { cache } from 'react';
import type { User } from '@supabase/supabase-js';
import { createServerClient } from '@/lib/supabase/server';

/**
 * The current request's verified Supabase user, or `null` when there is no
 * valid session. Memoized per request via React's `cache()` — safe to call
 * from any number of Server Components or `'use server'` functions invoked
 * during the same render; only the first call reaches Supabase.
 */
export const getVerifiedUser = cache(async (): Promise<User | null> => {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});
