/**
 * The browser half of access-token resolution for the REST client.
 *
 * Split from `session-server.ts` on purpose: that module imports
 * `next/headers`, which cannot be pulled into a client bundle. Keeping the two
 * runtimes in separate files means a client hook can import its token accessor
 * without dragging the server one along.
 *
 * The REST API authenticates a dashboard caller with the SAME Supabase user JWT
 * the browser session already holds (`resolveRestAuth`'s third tier), so no new
 * credential and no API token is involved: the session the user is signed into
 * IS the authorization, and RLS applies to it exactly as it did when the
 * dashboard queried PostgREST directly.
 *
 * `getSession()` rather than `getUser()`: the access token itself is what we
 * need, and `getUser()` costs a round trip to answer a different question. The
 * route on the other end re-verifies the token either way.
 */

import { createClient } from '@/lib/supabase/client';

/**
 * The signed-in user's access token, or `null` when there is no session.
 *
 * Returning `null` rather than throwing keeps the decision with the caller,
 * and the two callers make it differently on purpose: the client read hooks
 * (`queries/lore.ts`) turn it into a `NotAuthenticatedError` so a lapsed
 * session is distinguishable from an empty account, while the server actions
 * (`lib/lore.ts`) turn it into their `{ error: 'Not authenticated' }` result
 * shape. Neither treats a signed-out read as "no data".
 */
export async function browserAccessToken(): Promise<string | null> {
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token ?? null;
}
