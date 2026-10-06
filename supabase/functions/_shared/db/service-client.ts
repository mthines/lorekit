/**
 * A fresh service-role Supabase client, bypassing RLS.
 *
 * `_shared/api/auth.ts` already builds one of these (its private `svcClient`)
 * for the REST auth tiers, but does not export it — every existing caller
 * receives a client already resolved for the REQUEST's auth tier, which is
 * exactly wrong for `_shared/judgment/judgment-keys.ts`: a BYOK key is a
 * personal secret behind Vault, readable by NOTHING but `service_role`
 * (`supabase/migrations/00112_judgment_provider_keys.sql` grants every
 * `lorekit_judgment_key_*` RPC to `service_role` only), so the key store must
 * reach Postgres on its OWN service-role connection regardless of whether the
 * calling REST request authenticated as a JWT user, an `lk_*` token, or
 * service-role itself.
 *
 * A second, independent factory rather than exporting `auth.ts`'s private one:
 * that module's `db` parameter is deliberately the per-REQUEST client, and a
 * shared export from it would invite a future caller to reach for "the
 * service client" when what they actually want is the request's own — the
 * exact confusion `_shared/api/tenant.ts`'s whole module exists to prevent for
 * `api_key` auth. Naming this differently (`serviceClient`, not `svcClient`)
 * keeps the two call sites textually distinct in a `grep`.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { Database } from './database.types.ts';
import type { DbClient } from './db-client.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export function serviceClient(): DbClient {
  return createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
