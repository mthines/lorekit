// Zero-dependency mirror of the created_at validation used by the hosted MCP
// server (packages/mcp-core/src/limits/created-at.ts). Keeps the local `lorekit mcp`
// stdio server's memory.write contract identical to the remote one: an optional
// ISO 8601 creation-date override, rejected when invalid or future-dated.

export const CLOCK_SKEW_MS = 60_000;

// Validate and normalise an optional created_at override.
// Returns the ISO 8601 string, or null when no override was supplied.
// Throws Error on an invalid or future-dated value.
export function normalizeCreatedAt(input, now = new Date()) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new Error('created_at must be an ISO 8601 date-time string');
  }
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('created_at must be an ISO 8601 date-time string');
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`created_at is not a valid date-time: ${input}`);
  }
  if (ms > now.getTime() + CLOCK_SKEW_MS) {
    throw new Error('created_at cannot be in the future');
  }
  return new Date(ms).toISOString();
}
