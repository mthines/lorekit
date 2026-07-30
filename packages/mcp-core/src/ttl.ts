// Optional TTL (time-to-live) parameter for memory.write.
//
// When an agent writes a transient memory — e.g. "already triaged Linear issue
// ENG-123 in this session" — it can supply `ttl_days`, `ttl_minutes`, or
// `ttl_seconds` so the record auto-expires rather than accumulating forever.
//
// `parseTtl` is the single, pure validation gate. It is mirrored
// self-contained into the Deno edge function
// (supabase/functions/mcp/ttl.ts) — the same pattern as created-at.ts and
// limits.ts. Keep the two copies behaviourally identical; the vitest suite
// here is the shared guard.
//
// Unit precedence: if more than one unit is supplied, throws a TtlError.
// Resolution: all units are normalised to integer seconds before being
// forwarded to the DB as p_ttl_seconds.

export class TtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtlError';
  }
}

/** Minimum allowed TTL (seconds). Must be >= 1 second. */
export const TTL_MIN_SECONDS = 1;

/** Maximum allowed TTL (seconds). 365 days = 31 536 000 seconds. */
export const TTL_MAX_SECONDS = 365 * 24 * 60 * 60; // 31_536_000

/** Minimum allowed TTL (minutes). 1 minute. */
export const TTL_MIN_MINUTES = 1;

/** Maximum allowed TTL (minutes). 365 days in minutes. */
export const TTL_MAX_MINUTES = 365 * 24 * 60; // 525_600

/** Minimum allowed TTL (days). */
export const TTL_MIN_DAYS = 1;

/** Maximum allowed TTL (days). Sanity cap — 365 days = 1 year. */
export const TTL_MAX_DAYS = 365;

function parseFinitePositiveInteger(input: unknown, paramName: string): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) {
    throw new TtlError(`${paramName} must be a finite number`);
  }
  if (!Number.isInteger(n)) {
    throw new TtlError(`${paramName} must be an integer`);
  }
  return n;
}

/**
 * Validate and normalise an optional `ttl_seconds` write parameter.
 *
 * @returns the integer number of seconds, or `null` when no value was supplied.
 * @throws {TtlError} when the value is present but invalid.
 */
export function parseTtlSeconds(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  const n = parseFinitePositiveInteger(input, 'ttl_seconds');
  if (n < TTL_MIN_SECONDS) throw new TtlError(`ttl_seconds must be >= ${TTL_MIN_SECONDS}`);
  if (n > TTL_MAX_SECONDS) throw new TtlError(`ttl_seconds must be <= ${TTL_MAX_SECONDS}`);
  return n;
}

/**
 * Validate and normalise an optional `ttl_minutes` write parameter.
 *
 * @returns the integer number of minutes, or `null` when no value was supplied.
 * @throws {TtlError} when the value is present but invalid.
 */
export function parseTtlMinutes(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  const n = parseFinitePositiveInteger(input, 'ttl_minutes');
  if (n < TTL_MIN_MINUTES) throw new TtlError(`ttl_minutes must be >= ${TTL_MIN_MINUTES}`);
  if (n > TTL_MAX_MINUTES) throw new TtlError(`ttl_minutes must be <= ${TTL_MAX_MINUTES}`);
  return n;
}

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
  const n = parseFinitePositiveInteger(input, 'ttl_days');

  if (n < TTL_MIN_DAYS) throw new TtlError(`ttl_days must be >= ${TTL_MIN_DAYS}`);
  if (n > TTL_MAX_DAYS) throw new TtlError(`ttl_days must be <= ${TTL_MAX_DAYS}`);
  return n;
}

export interface TtlInput {
  ttl_days?: unknown;
  ttl_minutes?: unknown;
  ttl_seconds?: unknown;
}

/**
 * Resolve the TTL from any of the three optional unit parameters into a single
 * integer number of seconds, or `null` when no TTL was supplied.
 *
 * At most one of `ttl_days`, `ttl_minutes`, `ttl_seconds` may be supplied.
 * Supplying more than one throws a TtlError.
 *
 * @returns integer seconds (>= 1), or `null` when no TTL was requested.
 * @throws {TtlError} on validation failure or when multiple units are supplied.
 */
export function parseTtl(input: TtlInput): number | null {
  const days = parseTtlDays(input.ttl_days);
  const minutes = parseTtlMinutes(input.ttl_minutes);
  const seconds = parseTtlSeconds(input.ttl_seconds);

  const supplied = [days !== null, minutes !== null, seconds !== null].filter(Boolean).length;
  if (supplied > 1) {
    throw new TtlError('at most one of ttl_days, ttl_minutes, ttl_seconds may be supplied');
  }

  if (days !== null) return days * 24 * 60 * 60;
  if (minutes !== null) return minutes * 60;
  if (seconds !== null) return seconds;
  return null;
}
