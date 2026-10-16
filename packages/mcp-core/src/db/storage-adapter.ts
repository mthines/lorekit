/**
 * StorageAdapter — the single seam between LoreKit tool logic and the
 * underlying Supabase database.
 *
 * Two modes:
 *   hosted — the default. Points at the LoreKit hosted Supabase project.
 *            Rate limiting and billing telemetry are active.
 *   byod   — user supplies their own Supabase project URL + key.
 *            Rate limiting and billing telemetry are SKIPPED: LoreKit has
 *            no visibility into the user's private database and cannot meter
 *            memories stored there. BYOD users are exempt from hosted
 *            memory-count billing and must configure their own limits in
 *            their Supabase project.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface StorageAdapter {
  /** The underlying Supabase client. Tool handlers use this directly. */
  db: SupabaseClient;
  /**
   * Whether this adapter enforces hosted-LoreKit rate limiting.
   * false for BYOD — the user controls their own database and is responsible
   * for configuring rate limits there.
   */
  supportsRateLimit: boolean;
  /**
   * Whether this adapter records usage events for hosted billing.
   * false for BYOD — LoreKit cannot meter memories in the user's private
   * database. BYOD is billed flat-rate or is free, not by memory count.
   */
  supportsHostedBilling: boolean;
  mode: 'hosted' | 'byod';
}

/**
 * Create an adapter pointing at the LoreKit hosted Supabase project.
 * Pass a user JWT to get an RLS-scoped client; omit for service-role access.
 */
export function createHostedAdapter(jwt?: string): StorageAdapter {
  const url = process.env['SUPABASE_URL'] ?? '';
  const anonKey = process.env['SUPABASE_ANON_KEY'] ?? '';
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

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
    // BYOD billing: LoreKit cannot meter memories in the user's private database.
    // Memory-count billing does not apply. BYOD users are on a flat-rate or
    // open-source tier; no lorekit_record_usage_event calls are made.
    supportsHostedBilling: false,
    mode: 'byod',
  };
}

/**
 * Resolve the correct StorageAdapter from environment variables or config.
 *
 * Resolution order:
 *   1. LOREKIT_STORAGE_URL + LOREKIT_STORAGE_SERVICE_KEY → BYOD adapter
 *      (LOREKIT_STORAGE_ANON_KEY is accepted but unused once the service key is set)
 *   2. SUPABASE_URL + SUPABASE_ANON_KEY → hosted adapter (default)
 *
 * Throws if LOREKIT_STORAGE_URL is set without LOREKIT_STORAGE_SERVICE_KEY.
 */
export function resolveStorageAdapter(jwt?: string): StorageAdapter {
  const storageUrl = process.env['LOREKIT_STORAGE_URL'];
  const storageAnonKey = process.env['LOREKIT_STORAGE_ANON_KEY'];
  const storageServiceKey = process.env['LOREKIT_STORAGE_SERVICE_KEY'];

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
