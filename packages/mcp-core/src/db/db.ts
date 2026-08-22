import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface Memory {
  id: string;
  user_id: string | null;
  org_id: string | null;
  scope: string;
  key: string;
  value: string;
  tags: string[];
  source_agent: string | null;
  trigger: string | null;
  created_at: string;
  updated_at: string;
  /** ISO-8601 UTC timestamp set when the memory is soft-archived. Null for active memories. */
  archived_at: string | null;
}

/**
 * Create a Supabase client scoped to a specific user JWT.
 * RLS policies will enforce row-level access.
 */
export function createUserClient(url: string, anonKey: string, jwt: string): SupabaseClient {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Create a Supabase service-role client that bypasses RLS.
 * Used for CI writes and internal operations.
 */
export function createServiceClient(url: string, serviceKey: string): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
