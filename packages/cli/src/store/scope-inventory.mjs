// Normalising a store's scope inventory into ONE shape.
//
// `listScopes()` is the only store method whose two implementations disagree
// about their envelope: `LocalStore`/`TwoTierStore` return a BARE ARRAY of
// `{ scope, count }`, while `RemoteStore` returns the standard
// `{ ok, scopes }` — or `{ ok: false, error, networkError, unusable }`. Every
// caller that wants an inventory therefore has to know which store it is
// holding, which is exactly the knowledge a caller should not need.
//
// Two callers now want one: the `memory.scopes` MCP tool and the SessionStart
// scope map. Before this module they each carried their own copy of the
// array-vs-envelope branch, which is two places to get "what does a failed
// enumeration look like" subtly different.
//
// TOTAL FUNCTION. Anything unrecognisable — a null, a rejected promise's value,
// a row with a missing count — degrades to a usable answer with a reason
// attached. Both callers are best-effort paths: the MCP tool must not turn "I
// could not enumerate" into a tool error, and the hook must not lose a lesson
// injection over a failed count. Neither can afford a throw.
//
// Zero-dependency: no imports, not even node builtins.

/**
 * Normalise whatever `listScopes()` returned into `{ ok, scopes, reason }`.
 *
 * `ok` is false ONLY when the store could not answer. An empty store is a
 * SUCCESSFUL enumeration that found nothing (`ok: true`, `scopes: []`) — the
 * distinction matters, because "no scopes" and "I could not look" lead a caller
 * to different behaviour, and collapsing them is how a transient network error
 * ends up rendering as an authoritative empty inventory.
 *
 * `reason` is a short, bounded, non-PII note when `ok` is false, and null
 * otherwise. The vocabulary matches `lessons-view.mjs`'s `describeError`, so
 * the notes read alike wherever they surface — but it is built here rather than
 * imported, because this module is reached from the SessionStart hot path and
 * that one carries the whole render/`util` stack.
 */
export function normalizeScopeInventory(result) {
  // Local / two-tier: the bare array form.
  if (Array.isArray(result)) return { ok: true, scopes: result.map(shapeScopeRow), reason: null };

  // Remote: the envelope form.
  if (result && result.ok) {
    const scopes = Array.isArray(result.scopes) ? result.scopes : [];
    return { ok: true, scopes: scopes.map(shapeScopeRow), reason: null };
  }

  return { ok: false, scopes: [], reason: failureReason(result) };
}

/**
 * One inventory row, coerced.
 *
 * `last_activity` is passed through when the store supplied it (the hosted
 * `GET /memories/scopes` has returned it since migration 00049) and OMITTED —
 * never null — when it did not, so a consumer can tell "this store does not
 * report freshness" from "this scope has none".
 *
 * ONE DELIBERATE DIVERGENCE from the `shapeScope` this replaced, named here so
 * it is not mistaken for an accident: the count is clamped at 0, where the old
 * helper passed a negative through. A negative count is not a quantity any
 * store can honestly report — `LocalStore` increments a counter and the hosted
 * route is a `count(*)` — so it can only ever be a malformed row, and `-3` in a
 * `memory.scopes` answer is worse than `0`. Unreachable from either real store;
 * it is the coercion boundary being total, not a behaviour anyone can observe.
 */
export function shapeScopeRow(s) {
  const count = Number(s?.count);
  const row = { scope: String(s?.scope ?? ''), count: Number.isFinite(count) ? Math.max(0, count) : 0 };
  const last = s?.last_activity ?? s?.lastActivity;
  return last ? { ...row, last_activity: last } : row;
}

/** A short, bounded reason an enumeration produced nothing. */
export function failureReason(result) {
  if (!result) return 'the store returned no result';
  if (result.unusable) return 'no usable store is configured';
  if (result.networkError) return `network error: ${clip(result.networkError)}`;
  // `httpStatus` is the ONLY field carrying a real status: `restFetch`'s error
  // object is `{ message, code }`, and `code` is the response body's own
  // application code on a JSON error, so rendering it as "HTTP <code>" would
  // print a non-status. Read the top-level field first — that is the one
  // `RemoteStore.listScopes()` passes through — and keep the nested read as a
  // tolerance for any store that nests it instead.
  const status = result.httpStatus ?? result.error?.httpStatus;
  if (status) return `request failed with HTTP ${status}`;
  if (result.error?.message) return clip(result.error.message);
  return 'the store could not enumerate its scopes';
}

function clip(v) {
  return String(v).slice(0, 200);
}

/**
 * Ask a store for its inventory without letting it fail the caller.
 *
 * A store need not implement `listScopes` at all (a stub, a fixture, a future
 * adapter), and one that does may still throw. Both are ordinary here, so both
 * come back as `ok: false` with a reason rather than as an exception the caller
 * has to remember to catch.
 */
export async function readScopeInventory(store) {
  if (!store || typeof store.listScopes !== 'function') {
    return { ok: false, scopes: [], reason: 'this store cannot enumerate scopes' };
  }
  try {
    return normalizeScopeInventory(await store.listScopes());
  } catch (e) {
    return { ok: false, scopes: [], reason: `scope enumeration failed: ${clip(e?.message ?? e)}` };
  }
}
