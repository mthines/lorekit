#!/usr/bin/env node
/**
 * Seed (idempotently) the fixed smoke user the orgs REST smoke signs in as.
 *
 * ## Why a script instead of creating the user by hand
 *
 * The orgs smoke (`smoke-rest.mjs` → `orgs-api.integration`) authenticates as a
 * real Supabase USER (every `lorekit_org_*` RPC is SECURITY DEFINER and resolves
 * the actor as `auth.uid()` — `lk_*` tokens and the service-role key are both
 * rejected). `mint-smoke-jwt.mjs` mints that user's JWT in fixed-user mode by
 * signing in with `LOREKIT_SMOKE_EMAIL`/`LOREKIT_SMOKE_PASSWORD`, but it never
 * *creates* the user (a smoke run must not provision users in a real tenant).
 *
 * So the user has to exist up front. Doing that by hand in the dashboard is
 * error-prone in exactly the way that bites silently: an unconfirmed email or a
 * mistyped password both surface only later as `HTTP 400 invalid_credentials`
 * at mint time — which, with the best-effort mint, is an announced-but-silent
 * orgs skip, not a hard error. This script removes that class of mistake: it is
 * idempotent, reproducible, identical across preview and production, and it
 * VERIFIES the password sign-in end-to-end before reporting success — the exact
 * thing a manual create can't confirm.
 *
 * ## Where to run it
 *
 * ONCE per project (preview, then production), from a trusted admin shell —
 * NOT in CI. Creating a confirmed user requires the service-role key (the Auth
 * admin API), which the recurring deploy smoke path deliberately does NOT carry
 * (CI only ever uses the anon key + email/password to mint a JWT). Keep the
 * service-role key on your machine / a secret store, not in a workflow.
 *
 * ## What it does (idempotent, self-healing)
 *
 *   1. Try to sign in with the configured email+password. If it already works,
 *      the user is seeded correctly — exit 0 without touching the admin API.
 *   2. Otherwise ensure the user via the admin API: create it with
 *      `email_confirm: true`; if it already exists, reset its password and
 *      re-confirm it (so a drifted/forgotten password heals on re-run).
 *   3. Sign in again to PROVE the credential works, then exit 0. If the final
 *      sign-in still fails, exit non-zero with an actionable message.
 *
 * ## Usage
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
 *   LOREKIT_SMOKE_EMAIL=smoke@lorekit.io \
 *   LOREKIT_SMOKE_PASSWORD='<strong-password>' \
 *     node scripts/seed-smoke-user.mjs
 *
 * Env:
 *   SUPABASE_URL              e.g. https://<ref>.supabase.co  (or derived from
 *                             LOREKIT_REST_BASE_URL by stripping /functions/v1)
 *   SUPABASE_SERVICE_ROLE_KEY required — the Auth admin API (create/update user)
 *   SUPABASE_ANON_KEY         optional; the service-role key is used as the
 *                             `apikey` header (for sign-in) when this is unset
 *   LOREKIT_SMOKE_EMAIL       required
 *   LOREKIT_SMOKE_PASSWORD    required
 *
 * Every diagnostic goes to stderr; the script prints nothing sensitive to
 * stdout. Exits 0 only when the user exists AND the password sign-in verifies.
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
    fail(
      `cannot reach ${url}\n` +
        `  ${e?.message ?? e}\n` +
        `  Is SUPABASE_URL the API origin (no /functions/v1 suffix) and reachable?`,
    );
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page — surfaced verbatim by callers */
  }
  return { status: res.status, ok: res.ok, body, text };
}

/** Password grant. Returns the access token on success, or null on 400. */
async function trySignIn(supabaseUrl, apikey, email, password) {
  const { ok, body } = await authFetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, apikey, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return ok && body?.access_token ? body.access_token : null;
}

/** Find an existing user's id by email, paging through the admin list. */
async function findUserId(supabaseUrl, apikey, serviceKey, email) {
  const wanted = email.toLowerCase();
  // Request 200/page, but terminate on an EMPTY page rather than a short one:
  // GoTrue may cap `per_page` below what we ask (its default is 50), so a page
  // shorter than requested is NOT proof it's the last one — only an empty page
  // is. The page cap is a runaway backstop, not the normal exit.
  for (let page = 1; page <= 50; page++) {
    const { ok, status, body, text } = await authFetch(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=200`,
      apikey,
      { headers: { Authorization: `Bearer ${serviceKey}` } },
    );
    if (!ok) fail(`admin user list failed (HTTP ${status})\n  ${body ? JSON.stringify(body) : text.slice(0, 300)}`);
    const users = Array.isArray(body) ? body : (body?.users ?? []);
    if (users.length === 0) return null; // genuinely past the last page, no match
    const match = users.find((u) => String(u?.email ?? '').toLowerCase() === wanted);
    if (match?.id) return match.id;
  }
  return null;
}

const supabaseUrl = resolveSupabaseUrl();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
// GoTrue only requires `apikey` to be a valid project key; the service-role key
// qualifies, so the anon key is optional.
const apikey = process.env.SUPABASE_ANON_KEY || serviceKey;
const email = process.env.LOREKIT_SMOKE_EMAIL;
const password = process.env.LOREKIT_SMOKE_PASSWORD;

if (!email || !password) {
  fail('set LOREKIT_SMOKE_EMAIL and LOREKIT_SMOKE_PASSWORD (the fixed smoke user to seed).');
}
if (!serviceKey) {
  fail('set SUPABASE_SERVICE_ROLE_KEY — creating/confirming a user needs the Auth admin API.');
}

// 1. Already seeded correctly? Then this is a no-op and we never touch admin.
if (await trySignIn(supabaseUrl, apikey, email, password)) {
  log(`ok — smoke user already seeded at ${supabaseUrl} (sign-in verified); nothing to do.`);
  process.exit(0);
}

// 2. Ensure the user via the admin API.
log(`seeding smoke user ${email} at ${supabaseUrl}`);
const created = await authFetch(`${supabaseUrl}/auth/v1/admin/users`, apikey, {
  method: 'POST',
  headers: { Authorization: `Bearer ${serviceKey}` },
  // email_confirm short-circuits the confirmation mail; without it the user
  // exists but cannot sign in — the exact silent-skip this script prevents.
  body: JSON.stringify({ email, password, email_confirm: true }),
});

if (created.ok) {
  log('  created a new confirmed user');
} else {
  // Take the heal-the-password path ONLY for a genuine "already registered".
  // A bare 422 is NOT a reliable signal — GoTrue also returns 422 for
  // weak_password / invalid email, which would wrongly enter the heal branch
  // and then die in findUserId ("already existing but was not found"). Match
  // GoTrue's exists signal precisely (error_code email_exists /
  // user_already_exists, or the "already been registered" message); 409
  // Conflict is unambiguous. Anything else is a real, reported failure.
  const errText = JSON.stringify(created.body ?? created.text ?? '').toLowerCase();
  const alreadyExists =
    created.status === 409 ||
    errText.includes('email_exists') ||
    errText.includes('user_already_exists') ||
    errText.includes('already been registered') ||
    errText.includes('already registered');
  if (!alreadyExists) {
    fail(
      `admin user creation failed (HTTP ${created.status})\n` +
        `  ${created.body ? JSON.stringify(created.body) : created.text.slice(0, 300)}\n` +
        `  The key must be the SERVICE-ROLE key — the anon key cannot reach /auth/v1/admin.`,
    );
  }
  log('  user already exists — resetting its password and re-confirming');
  const id = await findUserId(supabaseUrl, apikey, serviceKey, email);
  if (!id) {
    fail(
      `the user reports as already existing but was not found in the admin list for ${email}.\n` +
        `  Cannot reset its password. Check the email and that this is the right project.`,
    );
  }
  const updated = await authFetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, apikey, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ password, email_confirm: true }),
  });
  if (!updated.ok) {
    fail(
      `admin user update failed (HTTP ${updated.status})\n` +
        `  ${updated.body ? JSON.stringify(updated.body) : updated.text.slice(0, 300)}`,
    );
  }
}

// 3. Prove the credential actually works — the whole point of the script.
if (!(await trySignIn(supabaseUrl, apikey, email, password))) {
  fail(
    'the user was created/updated but the password sign-in still failed.\n' +
      '  Check that email+password sign-in is enabled on this project (Auth ▸ Providers ▸ Email).',
  );
}

log('ok — smoke user seeded and sign-in verified. The orgs REST smoke will now run on this project.');
process.exit(0);
