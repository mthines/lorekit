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

export const TTL_MIN_SECONDS = 1;
export const TTL_MAX_SECONDS = 365 * 24 * 60 * 60; // 31_536_000

export const TTL_MIN_MINUTES = 1;
export const TTL_MAX_MINUTES = 365 * 24 * 60; // 525_600

export const TTL_MIN_DAYS = 1;
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

export function parseTtlSeconds(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  const n = parseFinitePositiveInteger(input, 'ttl_seconds');
  if (n < TTL_MIN_SECONDS) throw new TtlError(`ttl_seconds must be >= ${TTL_MIN_SECONDS}`);
  if (n > TTL_MAX_SECONDS) throw new TtlError(`ttl_seconds must be <= ${TTL_MAX_SECONDS}`);
  return n;
}

export function parseTtlMinutes(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  const n = parseFinitePositiveInteger(input, 'ttl_minutes');
  if (n < TTL_MIN_MINUTES) throw new TtlError(`ttl_minutes must be >= ${TTL_MIN_MINUTES}`);
  if (n > TTL_MAX_MINUTES) throw new TtlError(`ttl_minutes must be <= ${TTL_MAX_MINUTES}`);
  return n;
}

export function parseTtlDays(input: unknown): number | null {
  if (input === undefined || input === null) return null;
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
 * integer number of seconds, or null when no TTL was supplied.
 * At most one unit may be supplied; supplying multiple throws TtlError.
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
