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
//
// `resolveDefaultTtlDays` is the one piece here with NO server counterpart, by
// design. It answers "what TTL did the user configure for a write that named
// none?" — a client-side policy question. The server contract is untouched:
// omitting `ttl_*` on `memory.write` still means the row is permanent, so an
// agent talking straight to the MCP endpoint is unaffected by a config file it
// cannot see. That asymmetry is deliberate; moving the default server-side would
// silently change what "omitted" means for every existing caller.

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

// Whether a stored entry is currently visible to reads: not archived and not
// expired. The SINGLE definition of "live", shared by every read path (list /
// read / listScopes) so a future hidden dimension is added once, never
// re-spelled per call site. The raw primitives (getEntry / _findByKey for
// delete / archive) deliberately bypass this so they can still act on hidden rows.
export function isLive(entry, now = new Date()) {
  return !entry.archived_at && !isExpired(entry.expires_at, now);
}

// The DEFAULT TTL for a write that named none, resolved from the config layers
// (`ttl.default` and `scope.defaults.<prefix>.ttl_days` — see control.mjs).
//
// Returns the number of days, or null for "no default; the memory is permanent".
//
// Two rules that matter more than they look:
//
//   1. LONGEST MATCHING PREFIX WINS, not first-declared. `scope.defaults` is a
//      plain object, so declaration order is whatever the author's editor left
//      behind; a `branch::` entry and a `branch::owner/repo::` entry must resolve
//      deterministically, and the more specific one is the one the author meant.
//      (`tagsHint` UNIONS every match instead — correct there, because tags
//      accumulate and a TTL cannot.)
//   2. AN EXPLICIT `null` MEANS PERMANENT and outranks `ttl.default`. Without it
//      a repo-wide default could not be switched off for the one scope that
//      holds durable lore, and `"ttl_days": null` is the only honest spelling of
//      "keep this forever" — omitting the key has to keep meaning "inherit".
//
// Total by contract: a malformed config (fractional days, a string, out of
// range, a non-object entry) yields null rather than throwing. A config file is
// not a caller assertion the way `--ttl-days` is — it is ambient state that must
// never be able to break an unrelated write, the same posture the hook engine
// takes toward the host agent.
export function resolveDefaultTtlDays(scope, { ttlDefault = null, scopeDefaults = null } = {}) {
  if (typeof scope === 'string' && scope && scopeDefaults && typeof scopeDefaults === 'object') {
    let bestPrefix = null;
    let bestValue;
    for (const [prefix, cfg] of Object.entries(scopeDefaults)) {
      if (!cfg || typeof cfg !== 'object' || !('ttl_days' in cfg)) continue;
      if (!matchesScopePrefix(scope, prefix)) continue;
      if (bestPrefix !== null && prefix.length <= bestPrefix.length) continue;
      bestPrefix = prefix;
      bestValue = cfg.ttl_days;
    }
    if (bestPrefix !== null) {
      if (bestValue === null) return null; // explicit "permanent" for this scope
      return safeTtlDays(bestValue);
    }
  }
  return safeTtlDays(ttlDefault);
}

// Whether a write's resolved scope falls under a `scope.defaults` key. An exact
// match, or a `::`-delimited descendant — so `repo::owner` never captures
// `repo::owner-other/x`. Shared with the nudge's tags hint so the two cannot
// disagree about what "this scope is configured" means.
export function matchesScopePrefix(scope, prefix) {
  if (typeof scope !== 'string' || typeof prefix !== 'string' || !prefix) return false;
  if (scope === prefix) return true;
  return scope.startsWith(prefix.endsWith('::') ? prefix : prefix + '::');
}

// parseTtlDays, but a rejected value degrades to null instead of throwing.
//
// The type guard is not redundant with parseTtlDays: that one coerces with
// Number(), which maps `true` to 1 and `[]` to 0 — fine for a flag the user
// typed (a CLI flag is always a string), a footgun for a JSON value where `true`
// is a plausible typo for "yes, expire these" and would silently mean ONE DAY.
// Only a number or a numeric string is a TTL here.
function safeTtlDays(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
    return null;
  }
  try {
    return parseTtlDays(value);
  } catch {
    return null;
  }
}

// Resolve a write's `expires_at` from the tri-state TTL inputs, mirroring
// memory_write (00030/00031): `clearTtl` wins (→ permanent, and `ttlDays` is
// never even validated); else a supplied `ttlDays` sets expiry from `now`; else
// the row keeps whatever `current` expiry it already had. Throws (via
// parseTtlDays) on an invalid `ttlDays` only when NOT clearing, so the caller
// can surface `{ ok:false }`.
export function resolveExpiresAt({ clearTtl, ttlDays, now, current } = {}) {
  if (clearTtl) return null;
  const days = parseTtlDays(ttlDays);
  if (days != null) return expiresAtFrom(days, now);
  return current ?? null;
}
