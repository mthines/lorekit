/**
 * StorageAdapter — Deno edge function mirror of packages/mcp-core/src/db/storage-adapter.ts
 *
 * Self-contained (no cross-package imports). Keep in sync with the Node.js
 * source when either changes (the limits.ts / auth-token.ts pattern).
 *
 * BYOD billing note: LoreKit cannot meter memories in a user's private database.
 * When supportsHostedBilling is false, lorekit_record_usage_event is never called
 * and no hosted memory-count billing occurs. BYOD users are exempt from hosted
 * memory-count billing.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import type { DbClient } from '../_shared/db/db-client.ts';
import type { Database } from '../_shared/db/database.types.ts';

export interface StorageAdapter {
  db: DbClient;
  supportsRateLimit: boolean;
  supportsHostedBilling: boolean;
  mode: 'hosted' | 'byod';
}

export function createHostedAdapter(jwt?: string): StorageAdapter {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const db = jwt
    ? createClient<Database>(url, anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : (() => {
        if (!serviceKey) {
          throw new Error(
            'SUPABASE_SERVICE_ROLE_KEY is required for service-role access. ' +
              'Set this environment variable or pass a JWT to use user-scoped access.',
          );
        }
        return createClient<Database>(url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
      })();

  return { db, supportsRateLimit: true, supportsHostedBilling: true, mode: 'hosted' };
}

/**
 * Create an adapter pointing at a user-supplied Supabase project.
 * Rate limiting and billing telemetry are disabled — see interface JSDoc.
 *
 * Pass an optional serviceKey to use service-role access for privileged
 * operations; falls back to anonKey when serviceKey is not provided.
 */
export function createBYODAdapter(url: string, anonKey: string, serviceKey?: string): StorageAdapter {
  // Key precedence: serviceKey wins when provided; falls back to anonKey.
  // WARNING: the service key bypasses RLS entirely — any query executed with
  // the resulting client sees ALL rows in the BYOD database regardless of any
  // row-level security policies. Only pass a service key if your BYOD project
  // enforces data isolation through application-level checks (e.g. user_id
  // column filters), not through auth.uid()-based RLS policies.
  const key = serviceKey || anonKey;
  const db = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    db,
    supportsRateLimit: false,
    supportsHostedBilling: false,
    mode: 'byod',
  };
}

export function resolveStorageAdapter(jwt?: string): StorageAdapter {
  const storageUrl = Deno.env.get('LOREKIT_STORAGE_URL');
  const storageAnonKey = Deno.env.get('LOREKIT_STORAGE_ANON_KEY');
  const storageServiceKey = Deno.env.get('LOREKIT_STORAGE_SERVICE_KEY');

  if (storageUrl) {
    // The service key is required, not optional: the storage project's read
    // policies need auth.uid(), which an API key never carries, so an anon-key
    // client writes (memory_write is SECURITY DEFINER) but reads back nothing.
    // Fail at configuration rather than return empty reads that look healthy.
    if (!storageServiceKey) {
      throw new Error(
        'LOREKIT_STORAGE_URL is set but LOREKIT_STORAGE_SERVICE_KEY is missing. ' +
          'BYOD needs the storage project\'s service-role key: with only the anon key every read returns no rows.',
      );
    }
    return createBYODAdapter(storageUrl, storageAnonKey ?? '', storageServiceKey);
  }

  return createHostedAdapter(jwt);
}

/**
 * The user id a tool call filters its reads and stamps its writes with.
 *
 * Hosted: an `api_key` caller runs on the service-role client, so it is scoped
 * in app code by its id; a JWT (`user`) caller gets a client carrying its own
 * JWT, so RLS scopes it and the id stays null; `service` sees everything.
 *
 * BYOD: the storage client is built from the storage project's SERVICE key and
 * never carries the caller's JWT, so RLS cannot scope a JWT caller there. Left
 * at null it would read every row in the storage project and write rows with
 * no owner. It is scoped in app code by its resolved id instead — the same path
 * an `api_key` caller takes. A JWT caller with no resolved id is refused rather
 * than allowed through unscoped.
 */
export function storageUserId(
  mode: StorageAdapter['mode'],
  auth: { type: 'user' | 'service' | 'api_key'; userId?: string | null },
): string | null {
  if (auth.type === 'api_key') return auth.userId ?? null;
  if (auth.type === 'user' && mode === 'byod') {
    if (!auth.userId) throw new Error('BYOD: the session has no resolved user id, so its reads cannot be scoped.');
    return auth.userId;
  }
  return null;
}
