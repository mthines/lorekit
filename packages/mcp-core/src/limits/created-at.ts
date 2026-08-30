// Optional creation-date override for memory.write.
//
// When migrating pre-existing memories into LoreKit, the caller may supply the
// memory's ORIGINAL creation date via the write tool's `created_at` param so the
// dashboard dates it correctly instead of showing the migration wall-clock time.
//
// `parseCreatedAt` is the single, pure validation gate for that value. It is
// mirrored self-contained into the Deno edge tree
// (supabase/functions/_shared/limits/created-at.ts — `_shared/` because BOTH the MCP
// tools and the REST `POST /memories` handler validate the override through it)
// — the edge runtime cannot cross-import
// this package, the same pattern as limits.ts and webhook-secret-select.ts. Keep
// the two copies behaviourally identical; the vitest suite here is the guard.

export class CreatedAtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatedAtError';
  }
}

// Reject timestamps more than this far past "now" as future-dated. A small skew
// tolerance absorbs client/server clock drift without allowing genuinely
// future creation dates (nonsensical for a migration).
export const CLOCK_SKEW_MS = 60_000;

/**
 * Validate and normalise an optional `created_at` override.
 *
 * @returns the value normalised to an ISO 8601 string, or `null` when no
 *   override was supplied (the DB then applies its `now()` default).
 * @throws {CreatedAtError} when the value is present but not a valid,
 *   non-future date-time.
 */
export function parseCreatedAt(input: unknown, now: Date = new Date()): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new CreatedAtError('created_at must be an ISO 8601 date-time string');
  }
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new CreatedAtError('created_at must be an ISO 8601 date-time string');
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new CreatedAtError(`created_at is not a valid date-time: ${input}`);
  }
  if (ms > now.getTime() + CLOCK_SKEW_MS) {
    throw new CreatedAtError('created_at cannot be in the future');
  }
  return new Date(ms).toISOString();
}
