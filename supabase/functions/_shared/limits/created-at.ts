// Mirror of packages/mcp-core/src/limits/created-at.ts, self-contained for the Deno
// edge tree (which cannot cross-import the Node package — same pattern as
// limits.ts and webhook-secret-select.ts). Keep behaviourally identical to the
// mcp-core copy; the vitest suite over that copy is the shared guard, and
// `edge-parity.spec.ts` asserts this file stays in sync with it.
//
// Lives in `_shared/` (not `mcp/`) because both edge surfaces validate the
// optional `created_at` override through it: the MCP `memory.write` tool
// (mcp/tools.ts) and the REST `POST /memories` handler
// (memories/handlers/create.ts). One rule, one implementation.

export class CreatedAtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatedAtError';
  }
}

export const CLOCK_SKEW_MS = 60_000;

/**
 * Validate and normalise an optional `created_at` override for memory.write.
 * Returns the ISO 8601 string, or null when no override was supplied (the DB
 * then applies its now() default). Throws CreatedAtError on an invalid or
 * future-dated value.
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
