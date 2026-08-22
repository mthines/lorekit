/**
 * The ONE typed Supabase client every edge module shares.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * `database.types.ts` is generated from the live schema by
 * `pnpm nx db:types supabase` and has been committed, and imported for ROW
 * types (`Tables<'memories'>`), since orgs shipped. What it was never used for
 * is the thing it is primarily for: the `createClient` generic.
 *
 * Every call site said `createClient(url, key)`, so the client's schema was
 * unknown and postgrest-js resolved each `.from('memories')` row to `never` and
 * each `.rpc(name, args)` parameter to `undefined`. That is not a cosmetic
 * typing gap — it silently disabled type checking on EVERY database call in the
 * edge tree, which is why `_shared/api/auth.ts` could read `data.user_id` off a
 * `never` and why a dozen handlers cast a single row to and from an array with
 * nothing objecting. The 83 errors the first `deno check` found were the
 * SYMPTOM; the untyped client was the cause, and fixing it surfaced more
 * (98) before removing them all, because real types see real mismatches.
 *
 * ── Why an alias, and why here ────────────────────────────────────────────
 * The previous spelling was `ReturnType<typeof createClient>`, repeated at ~25
 * parameter positions. That idiom cannot carry the generic without repeating it
 * 25 times, and a client typed at the call site but not at the parameter it is
 * passed into produces the "SupabaseClient<any…> is not assignable to
 * SupabaseClient<Database…>" family — 13 of the original errors were exactly
 * that. One alias fixes the whole family and gives the tree a single name for
 * "our database client".
 *
 * It lives in its own module rather than in `database.types.ts` because that
 * file is GENERATED: anything hand-written there is destroyed the next time
 * someone regenerates the types. It is not in `api/auth.ts` either, where a
 * `DbClient` alias already existed, because the `mcp` function does not import
 * the REST auth module and should not have to in order to name its own client.
 * `api/auth.ts` now re-exports this one, so its existing importers are
 * unaffected.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { Database } from './database.types.ts';

/**
 * A Supabase client that knows LoreKit's schema.
 *
 * Use this for every `db` parameter in the edge tree. Never widen it back to
 * `SupabaseClient` or `ReturnType<typeof createClient>` to make an error go
 * away: that does not fix the mismatch, it re-hides it — along with every other
 * database call in the same module.
 */
export type DbClient = SupabaseClient<Database>;
