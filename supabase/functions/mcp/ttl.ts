// Mirror of packages/mcp-core/src/ttl.ts, self-contained for the Deno edge
// function (which cannot cross-import the Node package — same pattern as
// created-at.ts, limits.ts, and webhook-secret-select.ts). Keep behaviourally
// identical to the mcp-core copy; the vitest suite over that copy is the
// shared guard.

export class TtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtlError';
  }
}

export const TTL_MIN_DAYS = 1;
export const TTL_MAX_DAYS = 365;

/**
 * Validate and normalise an optional `ttl_days` write parameter.
 * Returns the integer number of days, or null when no TTL was supplied.
 * Throws TtlError when the value is present but invalid.
 */
export function parseTtlDays(input: unknown): number | null {
  if (input === undefined || input === null) return null;

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
