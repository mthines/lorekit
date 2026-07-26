#!/usr/bin/env node
// Inject the Dash0 ingesting-only telemetry token into the CLI at publish time.
//
// Reads LOREKIT_TELEMETRY_TOKEN from the environment (a GitHub Actions secret in
// the release workflow) and rewrites packages/cli/src/telemetry-token.mjs so the
// published npm tarball carries the token — without it ever being committed to
// git. Run right before `npm publish` in .github/workflows/release.yml.
//
// Idempotent and safe to run locally. If the env var is empty/unset it leaves
// the file as-is (telemetry stays off) and exits 0 — a missing secret must not
// break a release, it just publishes without default phone-home.
//
// The token is public once published (anyone can unpack the tarball), so it MUST
// be a Dash0 *ingesting-only* token.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const TARGET = fileURLToPath(
  new URL('../packages/cli/src/telemetry-token.mjs', import.meta.url),
);

/**
 * Pure transform: rewrite the exported TELEMETRY_TOKEN literal, preserving the
 * surrounding comment block. Returns the same string if the export is missing so
 * the caller can detect a failed replacement. Exported for unit testing.
 */
export function injectToken(source, token) {
  return source.replace(
    /export const TELEMETRY_TOKEN = .*;/,
    `export const TELEMETRY_TOKEN = ${JSON.stringify(token)};`,
  );
}

function main() {
  const token = (process.env.LOREKIT_TELEMETRY_TOKEN ?? '').trim();

  if (!token) {
    console.log(
      'inject-telemetry-token: LOREKIT_TELEMETRY_TOKEN not set — leaving token empty (telemetry off).',
    );
    return 0;
  }

  const source = readFileSync(TARGET, 'utf8');
  const next = injectToken(source, token);

  if (next === source) {
    console.error(
      'inject-telemetry-token: could not find the TELEMETRY_TOKEN export to replace.',
    );
    return 1;
  }

  writeFileSync(TARGET, next);
  console.log(
    `inject-telemetry-token: injected a ${token.length}-char token into telemetry-token.mjs.`,
  );
  return 0;
}

// Run only when executed directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
