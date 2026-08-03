/**
 * Stable, non-PII visitor identity for browser RUM.
 *
 * ## Why this exists
 *
 * `identify()` used to be called with exactly one value — the authenticated
 * Supabase user id — and only from the dashboard layout, which mounts behind
 * auth. Every event emitted before sign-in (marketing, `/docs`, `/login`, and
 * the pre-hydration part of an authenticated page load) therefore shipped with
 * no `user.id` at all, and Dash0 collapses all of them into a SINGLE anonymous
 * user. Measured on a 6h window of the `web` website: 731 of 1108 events and 29
 * of 36 sessions carried no identity, against exactly one distinct real user id.
 * Anonymous visitors were mutually indistinguishable, and a returning visitor
 * was indistinguishable from a first-time one (`session.id` resets per session,
 * so it cannot stand in for a visitor).
 *
 * ## What this is, and what it deliberately is not
 *
 * A random UUID in `localStorage`. No PII, no fingerprinting, no network call,
 * no correlation with anything the user did not do in this browser profile. It
 * survives reloads and sessions, and the user clears it by clearing site data.
 *
 * It is NOT an attempt to recognise the same human across devices, browsers, or
 * a private window — those are separate visitors by construction, and that is
 * the correct, privacy-preserving answer rather than a limitation to engineer
 * around.
 *
 * ## The `anon:` prefix
 *
 * Every anonymous id is prefixed so a query can separate anonymous traffic from
 * an authenticated Supabase user id (a bare UUID) without a join, and so
 * {@link isAnonymousId} can recognise — and refuse to reuse — a stored value
 * that is not one of ours.
 *
 * This module is intentionally **dependency-free** (no React, no `next/*`, no
 * node builtins) so it can be evaluated in both the browser bundle and, harmlessly,
 * during server prerendering.
 */

/** `localStorage` key holding the visitor id. Namespaced to avoid collisions. */
export const ANONYMOUS_ID_STORAGE_KEY = 'lorekit.anonymous_id';

/** Prefix marking an id as anonymous rather than an authenticated user id. */
export const ANONYMOUS_ID_PREFIX = 'anon:';

/**
 * The subset of the `Storage` API this module needs. Narrowed (rather than
 * taking the full `Storage`) so a test can pass a two-method stub and so the
 * module never reaches for a capability it does not use.
 */
export type AnonymousIdStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether `id` is one of ours.
 *
 * Used both to classify telemetry after the fact and, on read, to reject a
 * stored value that is empty or came from somewhere else — reusing such a value
 * as an identity would silently merge unrelated visitors.
 */
export function isAnonymousId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(ANONYMOUS_ID_PREFIX) && id.length > ANONYMOUS_ID_PREFIX.length;
}

/**
 * Mint a fresh anonymous id.
 *
 * `crypto.randomUUID` is available in every browser this app supports and in
 * Node 19+; the `crypto.getRandomValues` branch keeps the function total in the
 * one environment that has Web Crypto but not `randomUUID`, so a missing API
 * can never turn identification into a thrown error on a page load.
 */
function mintAnonymousId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : fallbackUuid();
  return `${ANONYMOUS_ID_PREFIX}${uuid}`;
}

/** RFC 4122 v4 from `getRandomValues`, for runtimes without `randomUUID`. */
function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Version 4, variant 10xx — required for the value to be a valid UUID.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The visitor's stable anonymous id, minting and persisting one on first call.
 *
 * **Total function.** Every failure mode returns a usable (if ephemeral) id
 * rather than throwing or returning null:
 *
 * - No storage at all (server prerender, or a browser with storage disabled)
 *   → a fresh id, not persisted.
 * - `getItem` / `setItem` throws (Safari private mode historically threw
 *   `QuotaExceededError` on write; some privacy extensions throw on read)
 *   → a fresh id, not persisted.
 * - A stored value that is not one of ours (empty, cleared to `''`, or written
 *   by something else) → replaced with a fresh id.
 *
 * That matters because this runs on the RUM init path: an exception here would
 * take down telemetry initialisation for the whole page, which is a far worse
 * outcome than an un-persisted id for one page load.
 *
 * @param storage injected for testing; defaults to `window.localStorage`.
 */
export function resolveAnonymousId(storage?: AnonymousIdStorage): string {
  const store = storage ?? defaultStorage();
  const fresh = mintAnonymousId();
  if (!store) return fresh;

  try {
    const existing = store.getItem(ANONYMOUS_ID_STORAGE_KEY);
    if (isAnonymousId(existing)) return existing as string;
    store.setItem(ANONYMOUS_ID_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return fresh;
  }
}

/**
 * `window.localStorage`, or `undefined` when there is no window (SSR) or the
 * property access itself throws — reading `window.localStorage` is enough to
 * throw a `SecurityError` when cookies are blocked, so the access is guarded
 * rather than only the method calls.
 */
function defaultStorage(): AnonymousIdStorage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
