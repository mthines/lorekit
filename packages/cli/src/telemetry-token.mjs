// Build-time injection point for the Dash0 ingesting-only telemetry token.
//
// The committed value is EMPTY on purpose — default telemetry stays off in the
// source tree and nothing secret is ever committed to git. The release workflow
// (.github/workflows/release.yml → publish-cli) overwrites this file at publish
// time from the LOREKIT_TELEMETRY_TOKEN secret via
// scripts/inject-telemetry-token.mjs, so only the *published npm tarball*
// carries the token.
//
// The token is public by design once published (anyone can unpack the tarball),
// so it MUST be a Dash0 *ingesting-only* token — it can POST spans but cannot
// read, query, or manage anything.
//
// At runtime this is only the lowest-priority source: an explicit
// LOREKIT_TELEMETRY_TOKEN env var or OTEL_EXPORTER_OTLP_HEADERS still win (see
// resolveTelemetryConfig in telemetry.mjs).
export const TELEMETRY_TOKEN = '';
