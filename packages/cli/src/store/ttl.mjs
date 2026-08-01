// Zero-dependency mirror of the TTL (time-to-live) contract used by the hosted
// MCP server (packages/mcp-core/src/ttl.ts) and the `memory_write` RPC
// (migrations 00030/00031). Keeps the local file store's expiry semantics
// identical to the remote one, so a memory written offline expires the same way
// it would have online — and a local↔remote migration is lossless.
//
//   - `ttl_days` (1–365) sets `expires_at = <write instant> + N days`, mirroring
//     the RPC's `now() + interval` — NOT `created + N`, so a backdated migration
//     (created_at override) still expires relative to when it was written.
//   - `clear_ttl` removes the expiry, making the row permanent again; it beats
//     `ttl_days` when both are supplied (the RPC's tri-state precedence).
//   - a read filters an expired row out lazily (there is no purge daemon
//     offline), exactly as the remote read paths do.

export const TTL_MIN_DAYS = 1;
export const TTL_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Validate and normalise an optional `ttl_days` write parameter.
// Returns the integer number of days, or null when no TTL was supplied.
// Throws Error on a present-but-invalid value (fractional, out of range, NaN).
export function parseTtlDays(input) {
  if (input === undefined || input === null) return null;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n)) throw new Error('ttl_days must be a finite number');
  if (!Number.isInteger(n)) throw new Error('ttl_days must be an integer');
  if (n < TTL_MIN_DAYS) throw new Error(`ttl_days must be >= ${TTL_MIN_DAYS}`);
  if (n > TTL_MAX_DAYS) throw new Error(`ttl_days must be <= ${TTL_MAX_DAYS}`);
  return n;
}

// The absolute ISO expiry instant for a memory: `from` (ISO string or Date)
// advanced by `ttlDays` whole days.
export function expiresAtFrom(ttlDays, from) {
  const base = from instanceof Date ? from.getTime() : Date.parse(from);
  return new Date(base + ttlDays * DAY_MS).toISOString();
}

// Whether a stored `expires_at` has elapsed at `now`. Absent → never expires.
// An unparseable value fails SAFE (treated as never-expiring) so a corrupt or
// hand-edited frontmatter field can never hide a lesson from every read.
export function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return false;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return false;
  return ms <= now.getTime();
}
