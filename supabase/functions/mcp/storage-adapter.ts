/**
 * StorageAdapter — Deno edge function mirror of packages/mcp-core/src/storage-adapter.ts
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

export interface StorageAdapter {
  db: ReturnType<typeof createClient>;
  supportsRateLimit: boolean;
  supportsHostedBilling: boolean;
  mode: 'hosted' | 'byod';
}

export function createHostedAdapter(jwt?: string): StorageAdapter {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const db = jwt
    ? createClient(url, anonKey, {
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
        return createClient(url, serviceKey, {
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
  const db = createClient(url, key, {
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
    if (!storageAnonKey) {
      throw new Error(
        'LOREKIT_STORAGE_URL is set but LOREKIT_STORAGE_ANON_KEY is missing. ' +
          'Both variables are required to use a custom database.',
      );
    }
    return createBYODAdapter(storageUrl, storageAnonKey, storageServiceKey);
  }

  return createHostedAdapter(jwt);
}
