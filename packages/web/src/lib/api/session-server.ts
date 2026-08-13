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
import { isLocalModeServer, LOCAL_MODE_TOKEN } from '@/lib/local-mode';

/**
 * The signed-in user's access token, or `null` when there is no session.
 *
 * In local web dev mode (plan D3 — gated on the RUNTIME flag
 * `LOREKIT_LOCAL_MODE`, unlike the browser half's build-inlined
 * `NEXT_PUBLIC_LOREKIT_LOCAL_MODE`, since this module runs only on the server
 * and `lorekit serve` sets it as a plain process env var on the dashboard
 * process it spawns) this returns the same fixed sentinel
 * `browserAccessToken` does — the local REST shim ignores its value entirely,
 * so the two only need to agree that SOME non-empty string is sent.
 * INVARIANT (AC-12): with the flag unset, this is byte-for-byte what it was
 * before this branch existed.
 */
export async function serverAccessToken(): Promise<string | null> {
  if (isLocalModeServer()) return LOCAL_MODE_TOKEN;
  const supabase = await createServerClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
