/**
 * Retention-policies ("grooming") feature flag — impure, Deno-only.
 *
 * Kept out of `groom.ts` because that module is a verbatim mirror of
 * `packages/mcp-core/src/retention/groom.ts` (see its header) and
 * `edge-parity.spec.ts` byte-compares the two; a `Deno.env` read here would
 * desync them for no behavioural reason (mcp-core never runs on the edge
 * runtime and has no environment to read).
 *
 * `memories/handlers/{groom,policies,protect}.ts` all import this single
 * constant so the three REST routes agree with each other and with the MCP
 * gate declared separately in `mcp/tools.ts` (same flag name, same posture as
 * `GITHUB_APP_ENABLED` in `mcp/webhook.ts`: unset or anything but the string
 * 'true' keeps the feature dormant).
 */
export const RETENTION_POLICIES_ENABLED = Deno.env.get('LOREKIT_RETENTION_POLICIES_ENABLED') === 'true';
