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
 */
export function createBYODAdapter(url: string, anonKey: string): StorageAdapter {
  const db = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    db,
    supportsRateLimit: false,
    supportsHostedBilling: false,
    mode: 'byod',
  };
}

/**
 * Resolve the correct StorageAdapter from environment variables or config.
 *
 * Resolution order:
 *   1. LOREKIT_STORAGE_URL + LOREKIT_STORAGE_ANON_KEY → BYOD adapter
 *   2. SUPABASE_URL + SUPABASE_ANON_KEY → hosted adapter (default)
 *
 * Throws if LOREKIT_STORAGE_URL is set without LOREKIT_STORAGE_ANON_KEY.
 */
export function resolveStorageAdapter(jwt?: string): StorageAdapter {
  const storageUrl = process.env['LOREKIT_STORAGE_URL'];
  const storageAnonKey = process.env['LOREKIT_STORAGE_ANON_KEY'];

  if (storageUrl) {
    if (!storageAnonKey) {
      throw new Error(
        'LOREKIT_STORAGE_URL is set but LOREKIT_STORAGE_ANON_KEY is missing. ' +
          'Both variables are required to use a custom database.',
      );
    }
    return createBYODAdapter(storageUrl, storageAnonKey);
  }

  return createHostedAdapter(jwt);
}
