#!/usr/bin/env node
// Inject the Dash0 ingesting-only telemetry token into the CLI at publish time.
//
// Reads LOREKIT_TELEMETRY_TOKEN from the environment (a GitHub Actions secret in
// the release workflow) and rewrites packages/cli/src/telemetry-token.mjs so the
// published npm tarball carries the token — without it ever being committed to
// git. Run right before `npm publish` in .github/workflows/release.yml.
//
// Idempotent and safe to run locally. Run bare, an empty/unset env var leaves
// the file as-is (telemetry stays off) and exits 0 — a local run must not break
// on a secret it was never meant to have. Pass `--require` to turn that no-op
// into exit 1 instead: publishing a tarball with telemetry silently off is the
// failure mode that goes unnoticed for days. Wiring `--require` into the
// release job is documented, not committed (docs/otel.md → "Wiring the export
// gate into CI"), so the job runs bare today. Either way, a token that is set
// but cannot be substituted into the target file always exits 1.
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
  // `--require` turns the silent no-op below into a hard failure. It is meant
  // for the release job (that wiring is documented in docs/otel.md, not
  // committed): publishing a tarball with telemetry off is exactly the failure
  // mode that goes unnoticed for days — the CLI keeps working, it just stops
  // phoning home, and nothing anywhere goes red. Local runs (no flag) keep the
  // forgiving behaviour.
  const require_ = process.argv.includes('--require');

  if (!token) {
    if (require_) {
      console.error(
        'inject-telemetry-token: LOREKIT_TELEMETRY_TOKEN is not set, but --require was passed. ' +
          'Publishing now would ship a CLI that silently emits no telemetry. ' +
          'Set the LOREKIT_TELEMETRY_TOKEN repository secret to a Dash0 ingesting-only token.',
      );
      return 1;
    }
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
