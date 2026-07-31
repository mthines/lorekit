#!/usr/bin/env node
/**
 * Mint a Supabase **user JWT** for the orgs REST smoke suite.
 *
 * ## Why this exists rather than a stored secret
 *
 * `LOREKIT_SMOKE_JWT` cannot be a GitHub secret. A Supabase access token is a
 * short-lived signed assertion, not a credential: `jwt_expiry` is 86400s
 * locally (supabase/config.toml) and 3600s by default on a hosted project. A
 * value pasted into repository settings is therefore dead within a day, and
 * its failure mode is the worst kind — `orgs-api.integration` self-skips on a
 * falsy/rejected credential, so an expired token turns the suite green while
 * testing nothing. The token must be minted at the start of every run.
 *
 * The org endpoints genuinely require a user JWT: every `lorekit_org_*` RPC is
 * SECURITY DEFINER and resolves the actor as `auth.uid()`, so the service-role
 * key and `lk_*` API tokens are both rejected (`requires: 'jwt'` in
 * `supabase/functions/orgs/index.ts`). No other credential can stand in.
 *
 * ## Two modes
 *
 * **Ephemeral (CI, local Supabase).** Given a service-role key, creates a
 * throwaway confirmed user via the Auth admin API and signs in as it. Nothing
 * is stored anywhere; the stack is torn down with the job.
 *
 * **Fixed user (staging / production).** Given `LOREKIT_SMOKE_EMAIL` +
 * `LOREKIT_SMOKE_PASSWORD`, signs in as that pre-existing user and creates
 * nothing. Use this against any real project — those two ARE storable secrets,
 * and this way the smoke run never provisions users in a real tenant.
 *
 * ## Usage
 *
 *   node scripts/mint-smoke-jwt.mjs                 # prints the access token
 *   JWT="$(node scripts/mint-smoke-jwt.mjs)"
 *
 * Env:
 *   SUPABASE_URL              e.g. http://127.0.0.1:54321  (or derived from
 *                             LOREKIT_REST_BASE_URL by stripping /functions/v1)
 *   SUPABASE_SERVICE_ROLE_KEY required for ephemeral mode
 *   SUPABASE_ANON_KEY         optional; the service-role key is used as the
 *                             `apikey` header when this is unset
 *   LOREKIT_SMOKE_EMAIL       fixed-user mode
 *   LOREKIT_SMOKE_PASSWORD    fixed-user mode
 *
 * Writes ONLY the token to stdout (so `$(...)` capture is clean); every
 * diagnostic goes to stderr. Exits non-zero with an actionable message rather
 * than printing an empty string, because an empty `LOREKIT_SMOKE_JWT` is
 * exactly the silent-skip failure this script exists to prevent.
 */

const log = (msg) => process.stderr.write(`${msg}\n`);

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/** `http://host/functions/v1` → `http://host`; a bare origin passes through. */
function resolveSupabaseUrl() {
  const explicit = process.env.SUPABASE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const restBase = process.env.LOREKIT_REST_BASE_URL;
  if (restBase) return restBase.replace(/\/functions\/v1\/?$/, '').replace(/\/$/, '');
  return 'http://127.0.0.1:54321';
}

async function authFetch(url, apikey, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { apikey, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (e) {
    // A refused connection is by far the most likely first failure (the stack
    // is still booting, or SUPABASE_URL points at the wrong port). Say that,
    // rather than dumping an unhandled-rejection stack.
    fail(
      `cannot reach ${url}\n` +
        `  ${e?.message ?? e}\n` +
        `  Is the stack up, and is SUPABASE_URL the API origin (no /functions/v1 suffix)?`,
    );
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page — surfaced verbatim below */
  }
  return { status: res.status, ok: res.ok, body, text };
}

/** Password grant → access token. The one step both modes share. */
async function signIn(supabaseUrl, apikey, email, password) {
  const { ok, status, body, text } = await authFetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    apikey,
    { method: 'POST', body: JSON.stringify({ email, password }) },
  );
  if (!ok || !body?.access_token) {
    fail(
      `sign-in failed (HTTP ${status}) for ${email}\n` +
        `  ${body ? JSON.stringify(body) : text.slice(0, 300)}\n` +
        `  Check the credentials, and that email+password sign-in is enabled on this project.`,
    );
  }
  return body.access_token;
}

const supabaseUrl = resolveSupabaseUrl();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
// GoTrue only requires the `apikey` header to be a valid project key; the
// service-role key qualifies, so the anon key is optional.
const apikey = process.env.SUPABASE_ANON_KEY || serviceKey;

const fixedEmail = process.env.LOREKIT_SMOKE_EMAIL;
const fixedPassword = process.env.LOREKIT_SMOKE_PASSWORD;

if (!apikey) {
  fail(
    'no API key. Set SUPABASE_SERVICE_ROLE_KEY (ephemeral mode) or SUPABASE_ANON_KEY\n' +
      '  alongside LOREKIT_SMOKE_EMAIL/LOREKIT_SMOKE_PASSWORD (fixed-user mode).',
  );
}

let token;

if (fixedEmail && fixedPassword) {
  log(`minting a JWT for the fixed smoke user at ${supabaseUrl}`);
  token = await signIn(supabaseUrl, apikey, fixedEmail, fixedPassword);
} else {
  if (!serviceKey) {
    fail(
      'ephemeral mode needs SUPABASE_SERVICE_ROLE_KEY (to create the throwaway user).\n' +
        '  For a real project set LOREKIT_SMOKE_EMAIL + LOREKIT_SMOKE_PASSWORD instead —\n' +
        '  a smoke run should not provision users in a real tenant.',
    );
  }

  // Unique per run so concurrent jobs never collide on the users_email_key
  // unique index, and so a run never inherits another run's orgs.
  const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@lorekit.test`;
  const password = `smoke-${Math.random().toString(36).slice(2)}-Aa1!`;

  log(`creating an ephemeral smoke user at ${supabaseUrl}`);
  const created = await authFetch(`${supabaseUrl}/auth/v1/admin/users`, apikey, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}` },
    // email_confirm short-circuits the confirmation mail: without it the user
    // exists but cannot sign in, which would surface as a confusing 400 below.
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) {
    fail(
      `admin user creation failed (HTTP ${created.status})\n` +
        `  ${created.body ? JSON.stringify(created.body) : created.text.slice(0, 300)}\n` +
        `  The key must be the SERVICE-ROLE key — the anon key cannot reach /auth/v1/admin.`,
    );
  }

  token = await signIn(supabaseUrl, apikey, email, password);
}

// A JWT is three dot-separated segments. Catching a non-token here is worth the
// two lines: the alternative is the orgs suite silently skipping on a value
// that looked present.
if (token.split('.').length !== 3) fail(`the minted value is not a JWT: ${token.slice(0, 40)}…`);

log('ok — JWT minted');
process.stdout.write(token);
