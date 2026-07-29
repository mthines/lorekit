// Optional TTL (time-to-live) parameter for memory.write.
//
// When an agent writes a transient memory — e.g. "already triaged Linear issue
// ENG-123 in this session" — it can supply `ttl_days` so the record auto-expires
// rather than accumulating forever.
//
// `parseTtlDays` is the single, pure validation gate. It is mirrored
// self-contained into the Deno edge function
// (supabase/functions/mcp/ttl.ts) — the same pattern as created-at.ts and
// limits.ts. Keep the two copies behaviourally identical; the vitest suite
// here is the shared guard.

export class TtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtlError';
  }
}

/** Minimum allowed TTL (days). */
export const TTL_MIN_DAYS = 1;

/** Maximum allowed TTL (days). Sanity cap — 365 days = 1 year. */
export const TTL_MAX_DAYS = 365;

/**
 * Validate and normalise an optional `ttl_days` write parameter.
 *
 * @returns the integer number of days, or `null` when no TTL was supplied
 *   (the DB then stores NULL in `expires_at`, meaning the row never expires).
 * @throws {TtlError} when the value is present but invalid.
 */
export function parseTtlDays(input: unknown): number | null {
  if (input === undefined || input === null) return null;

  // Accept numbers directly or numeric strings (for JSON schema flexibility).
  const n = typeof input === 'number' ? input : Number(input);

  if (!Number.isFinite(n)) {
    throw new TtlError('ttl_days must be a finite number');
  }
  if (!Number.isInteger(n)) {
    throw new TtlError('ttl_days must be an integer');
  }
  if (n < TTL_MIN_DAYS) {
    throw new TtlError(`ttl_days must be >= ${TTL_MIN_DAYS}`);
  }
  if (n > TTL_MAX_DAYS) {
    throw new TtlError(`ttl_days must be <= ${TTL_MAX_DAYS}`);
  }
  return n;
}
