// Deterministic synthetic id for a local-store row.
//
// `@lorekit/schemas`'s `MemoryEntrySchema` requires `id: uuid()` — a property
// of the HOSTED store's `memories.id` primary key, which the local file store
// has no equivalent of (a row is addressed by `scope::key`, never by a
// generated id). The REST shim still has to hand back an `id` for every row
// (list/get/patch all carry one), and `GET /memories/:id` / `PATCH
// /memories/:id` / the dashboard's `?memoryId=` deep link all need to resolve
// that id back to the row it names.
//
// D2 (plan): a UUIDv5 of `scope\x00key` (RFC 4122 §4.3, node:crypto only —
// no `uuid` package, keeping the CLI zero-dependency). It is:
//   - deterministic — the same scope::key always yields the same id, so a
//     link minted in one process resolves correctly after a restart;
//   - reversible by re-hashing every candidate row and comparing — no
//     persisted index is needed for the scale a local single-user store
//     targets (see plan D2's rationale).
//
// Zero-dependency: only node:crypto.
import crypto from 'node:crypto';

// A fixed namespace UUID for LoreKit's local-store synthetic ids. Any stable
// UUID works as a namespace (RFC 4122 places no meaning on the value beyond
// "distinct from other namespaces") — this one was generated once and MUST
// NEVER change, or every existing scope::key would resolve to a different id
// on upgrade, breaking every previously-shared `?memoryId=` link.
const NAMESPACE = '3b9f5c9e-6b3d-4f8e-9a1a-5b7d2f0c8e41';

function uuidToBytes(uuid) {
  return Buffer.from(String(uuid).replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * Deterministic UUIDv5 of `scope\x00key`.
 *
 * The NUL separator (never reachable in either a scope or a key string) means
 * `syntheticId('a', 'b::c')` and `syntheticId('a::b', 'c')` cannot collide —
 * a bare string concatenation could.
 */
export function syntheticId(scope, key) {
  const name = `${String(scope)}\x00${String(key)}`;
  const hash = crypto.createHash('sha1');
  hash.update(uuidToBytes(NAMESPACE));
  hash.update(Buffer.from(name, 'utf8'));
  const bytes = hash.digest().subarray(0, 16);
  const out = Buffer.from(bytes);
  out[6] = (out[6] & 0x0f) | 0x50; // version 5
  out[8] = (out[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(out);
}

/**
 * Resolve a synthetic id back to the row that produced it.
 *
 * `rows` is any list of `{ scope, key, ... }` objects (typically every raw
 * local-store row, live + archived + expired — the caller decides which
 * population to search). Re-hashes each candidate and compares; returns the
 * first match, or `null` when none resolves. O(n) in the row count, which is
 * the accepted tradeoff for a single-user local store with no persisted index
 * (see plan D2) — a `GET /memories/:id` on a store with thousands of rows
 * would want an index, but that store is not this feature's target.
 */
export function resolveSyntheticId(id, rows) {
  if (!id || !Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row && syntheticId(row.scope, row.key) === id) return row;
  }
  return null;
}
