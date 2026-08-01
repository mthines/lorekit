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
 * The signed-in user's access token, or `null` when there is no session —
 * a signed-out read is an empty result, not an error.
 */
export async function browserAccessToken(): Promise<string | null> {
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token ?? null;
}
