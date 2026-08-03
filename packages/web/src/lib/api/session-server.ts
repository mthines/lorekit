/**
 * The server half of access-token resolution for the REST client — used by the
 * server actions in `lib/lore.ts`.
 *
 * Kept apart from `session-browser.ts` because this module reaches for the
 * cookie store (`next/headers`), which is unavailable in a client bundle. Importing
 * `next/headers` is itself the guard: a client bundle that reached this module
 * would fail to build.
 */

import { createServerClient } from '@/lib/supabase/server';

/** The signed-in user's access token, or `null` when there is no session. */
export async function serverAccessToken(): Promise<string | null> {
  const supabase = await createServerClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
