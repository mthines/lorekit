import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Service-role ("admin") Supabase client for the Next.js server runtime.
 *
 * A handful of dashboard server routes/actions legitimately need to bypass RLS
 * (account deletion via auth.admin, linking a still-pending GitHub
 * installation whose row has user_id = NULL). They all go through this helper
 * so the env contract is declared in exactly one place.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is a SERVER-ONLY variable (no NEXT_PUBLIC_
 * prefix, never bundled into the browser). It must be set for every Vercel
 * environment — Production, Preview and Development. When it is missing,
 * `createClient()` throws the opaque `supabaseKey is required.` from
 * supabase-js, which surfaces as an unexplained 500. `createAdminClient()`
 * fails fast with a named, greppable error instead, and callers can translate
 * it into a 503 that names the misconfiguration.
 */

export const SERVICE_ROLE_KEY_ENV = 'SUPABASE_SERVICE_ROLE_KEY';
export const SUPABASE_URL_ENV = 'NEXT_PUBLIC_SUPABASE_URL';

/** Thrown when the server runtime is missing the env the admin client needs. */
export class SupabaseAdminConfigError extends Error {
  /** Stable machine-readable code — safe to return to the client. */
  readonly code = 'supabase_admin_not_configured';
  /** The env var that is unset or empty. */
  readonly missingEnv: string;

  constructor(missingEnv: string) {
    super(
      `${missingEnv} is not set. This server-only variable is required for ` +
        `privileged Supabase operations (e.g. account deletion). Set it for ` +
        `every Vercel environment, including Preview.`,
    );
    this.name = 'SupabaseAdminConfigError';
    this.missingEnv = missingEnv;
  }
}

/** True when the runtime has everything the admin client needs. */
export function isAdminConfigured(): boolean {
  return Boolean(process.env[SUPABASE_URL_ENV] && process.env[SERVICE_ROLE_KEY_ENV]);
}

/**
 * Build a service-role Supabase client.
 *
 * @throws {SupabaseAdminConfigError} when the URL or the service-role key is
 * unset/empty — never lets an empty key reach supabase-js.
 */
export function createAdminClient(): SupabaseClient {
  const url = process.env[SUPABASE_URL_ENV];
  const serviceRoleKey = process.env[SERVICE_ROLE_KEY_ENV];

  if (!url) throw new SupabaseAdminConfigError(SUPABASE_URL_ENV);
  if (!serviceRoleKey) throw new SupabaseAdminConfigError(SERVICE_ROLE_KEY_ENV);

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
