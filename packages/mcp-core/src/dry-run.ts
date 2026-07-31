/**
 * Dry-run request flag — the "safe explore" switch for the REST API.
 *
 * When a mutating request carries `X-LoreKit-Dry-Run: true`, the handler runs
 * every check (auth, validation, ownership) but STOPS before the write, so
 * create / update / delete make no changes. This is what lets the /api-docs
 * "Send" button hit destructive endpoints safely: the docs default the header
 * to `true`, and the user clears it to execute for real.
 *
 * The default when the header is ABSENT is `false` (real execution) — existing
 * REST/API-token clients that never send the header are unaffected.
 *
 * Import-free so it can be mirrored verbatim into
 * `supabase/functions/_shared/dry-run.ts` (Deno cannot import this Node package);
 * `edge-parity.spec.ts` guards the two copies against drift.
 */
export const DRY_RUN_HEADER = 'X-LoreKit-Dry-Run';

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export function isDryRunHeader(value: string | null | undefined): boolean {
  if (!value) return false;
  return TRUTHY.has(value.trim().toLowerCase());
}
