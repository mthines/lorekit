#!/usr/bin/env node
/**
 * REST API smoke runner.
 *
 * Runs the Edge-Function integration specs against a live stack. Those specs
 * `describe.skipIf(...)` on their credential, so they silently pass as
 * "skipped" unless it is present — this wrapper makes the requirement
 * explicit and fails loudly instead of pretending to have tested something.
 *
 * The two suites take DIFFERENT credentials, so they are gated separately:
 *
 *   memories-api.integration  SKIP = !LOREKIT_SMOKE_TOKEN  (service-role key,
 *                             lk_* API token, or user JWT). Always required —
 *                             the runner refuses to start without it.
 *   orgs-api.integration      SKIP = !LOREKIT_SMOKE_JWT    (a Supabase USER
 *                             JWT; the org endpoints reject lk_* tokens, so
 *                             the service-role key does NOT satisfy it).
 *
 * Because a service-role key cannot stand in for the user JWT, running the
 * orgs suite without `LOREKIT_SMOKE_JWT` only ever produces a self-skip that
 * reports as a pass. So it is only selected when the JWT is actually present;
 * otherwise it is left out and the omission is announced, rather than
 * appearing in the run as a green suite that tested nothing.
 *
 *   node scripts/smoke-rest.mjs <base-url> <token>
 *   node scripts/smoke-rest.mjs http://127.0.0.1:54321/functions/v1 "$KEY"
 *
 * Falls back to LOREKIT_REST_BASE_URL / LOREKIT_SMOKE_TOKEN when the
 * positional arguments are omitted. LOREKIT_SMOKE_JWT is env-only.
 */

import { spawnSync } from 'node:child_process';

const baseUrl =
  process.argv[2] ?? process.env.LOREKIT_REST_BASE_URL ?? 'http://127.0.0.1:54321/functions/v1';
const token = process.argv[3] ?? process.env.LOREKIT_SMOKE_TOKEN;

if (!token) {
  console.error(
    'error: no token.\n' +
      '  usage: node scripts/smoke-rest.mjs <base-url> <token>\n' +
      '  or set LOREKIT_SMOKE_TOKEN (service-role key, lk_* API token, or user JWT).\n' +
      '  Refusing to run: without a token the REST specs skip and report a false pass.',
  );
  process.exit(1);
}

const jwt = process.env.LOREKIT_SMOKE_JWT;

// memories is always gated; orgs is gated only when its own credential exists.
const suites = ['memories-api.integration'];
if (jwt) {
  suites.push('orgs-api.integration');
} else {
  console.log(
    'note: LOREKIT_SMOKE_JWT is not set — the orgs suite is NOT run and NOT gated by this step.\n' +
      '  It needs a Supabase user JWT (lk_* tokens and the service-role key are rejected by the\n' +
      '  org endpoints). Set LOREKIT_SMOKE_JWT to include it.',
  );
}

console.log(`REST smoke → ${baseUrl} (${suites.join(', ')})`);

const result = spawnSync('pnpm', ['nx', 'test', 'smoke-tests', '--', '--run', ...suites], {
  stdio: 'inherit',
  env: {
    ...process.env,
    LOREKIT_REST_BASE_URL: baseUrl,
    LOREKIT_SMOKE_TOKEN: token,
    ...(jwt ? { LOREKIT_SMOKE_JWT: jwt } : {}),
  },
});

process.exit(result.status ?? 1);
