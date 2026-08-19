/**
 * The ONE place the dashboard resolves which Supabase it talks to.
 *
 * By default every client — the browser auth client, the SSR client, the edge
 * middleware, and the REST data layer — reads `NEXT_PUBLIC_SUPABASE_URL` /
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which point at PRODUCTION
 * (`https://pqokxlhvnosogizsjztg.supabase.co`) in a normal `.env.local`.
 *
 * Set `NEXT_PUBLIC_USE_LOCAL_SUPABASE=true` (or `1`) to steer the WHOLE
 * dashboard at a local `supabase start` stack instead — the URL and anon key
 * below are the CLI's default, static, non-secret local values, so you don't
 * duplicate them into `.env.local`. This dodges the prod-CORS localhost block:
 * a local stack's edge functions default `ALLOWED_ORIGINS` to `*`.
 *
 * The `nx serve-local web` target just sets this flag.
 *
 * Both env reads are literal `process.env['…']` member expressions so Next.js
 * inlines them into the browser bundle at build time; keeping them here means
 * every call site inherits that guarantee for free. Resolved per call (not at
 * module load) so a test can set the env after import.
 */

/** Supabase CLI default local API URL (`[api] port = 54321`). */
const LOCAL_SUPABASE_URL = 'http://127.0.0.1:54321';

/**
 * Supabase CLI default local anon key — the well-known demo JWT signed with the
 * default local JWT secret. Static, non-secret, and identical across every
 * default `supabase start`. If your `supabase/config.toml` sets a custom JWT
 * secret, override it via `NEXT_PUBLIC_SUPABASE_ANON_KEY` with the flag off.
 */
const LOCAL_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlLWRlbW8iLCJpYXQiOjE2NDE3NjkyMDAsImV4cCI6MTc5OTUzNTYwMH0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE';

/**
 * True when the dashboard is pinned to a local `supabase start` stack.
 *
 * Named `is…`, not `use…`: this is a plain environment predicate, not a React
 * hook, and the `use` prefix would make `react-hooks/rules-of-hooks` treat every
 * call from a non-component function below as an illegal hook call.
 */
export function isLocalSupabase(): boolean {
  const flag = process.env['NEXT_PUBLIC_USE_LOCAL_SUPABASE'];
  return flag === 'true' || flag === '1';
}

/**
 * The Supabase URL every client should use. Local constant when the flag is on,
 * otherwise `NEXT_PUBLIC_SUPABASE_URL` (empty string when unset — callers that
 * require it, e.g. `restBaseUrl`, throw their own named configuration error).
 */
export function supabaseUrl(): string {
  if (isLocalSupabase()) return LOCAL_SUPABASE_URL;
  return process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '';
}

/** The Supabase anon key every client should use — local demo key when the flag is on. */
export function supabaseAnonKey(): string {
  if (isLocalSupabase()) return LOCAL_SUPABASE_ANON_KEY;
  return process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? '';
}
