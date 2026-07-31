/**
 * Dry-run request flag — the "safe explore" switch for the REST API.
 *
 * Self-contained mirror of `packages/mcp-core/src/dry-run.ts` (Deno cannot
 * import the Node package). Keep the two in sync — `edge-parity.spec.ts` fails
 * the build if the executable source diverges.
 *
 * When a mutating request carries `X-LoreKit-Dry-Run: true`, the handler runs
 * every check (auth, validation, ownership) but STOPS before the write. Absent
 * header ⇒ `false` (real execution), so existing clients are unaffected.
 */
export const DRY_RUN_HEADER = 'X-LoreKit-Dry-Run';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export function isDryRunHeader(value: string | null | undefined): boolean {
  if (!value) return false;
  return TRUTHY.has(value.trim().toLowerCase());
}
