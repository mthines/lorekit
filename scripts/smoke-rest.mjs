#!/usr/bin/env node
/**
 * REST API smoke runner.
 *
 * Runs the `memories` and `orgs` Edge-Function integration specs against a
 * live stack. Those specs `describe.skipIf(!TOKEN)`, so they silently pass as
 * "skipped" unless the token is present — this wrapper makes the requirement
 * explicit and fails loudly instead of pretending to have tested something.
 *
 *   node scripts/smoke-rest.mjs <base-url> <token>
 *   node scripts/smoke-rest.mjs http://127.0.0.1:54321/functions/v1 "$KEY"
 *
 * Falls back to LOREKIT_REST_BASE_URL / LOREKIT_SMOKE_TOKEN when the
 * positional arguments are omitted.
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

console.log(`REST smoke → ${baseUrl}`);

const result = spawnSync(
  'pnpm',
  ['nx', 'test', 'mcp-server', '--', '--run', 'memories-api.integration', 'orgs-api.integration'],
  {
    stdio: 'inherit',
    env: { ...process.env, LOREKIT_REST_BASE_URL: baseUrl, LOREKIT_SMOKE_TOKEN: token },
  },
);

process.exit(result.status ?? 1);
