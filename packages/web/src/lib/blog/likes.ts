/**
 * Pure logic for the blog post like counter (see `components/blog/PostLikes`).
 *
 * Dependency-free and total by construction: it runs in the browser (the like
 * button), on the server (the like server action clamps the delta with the same
 * rule), and in tests, so it must not reach for `window`, storage, or any
 * effect. Every function tolerates the messy inputs the persisted `localStorage`
 * value can take (missing, non-numeric, negative, fractional, absurd) and lands
 * on a value inside the valid range rather than throwing on the render path.
 *
 * The per-session cap is enforced HERE, client-side, because a blog visitor is
 * anonymous and has no server identity to key a per-session tally on. The
 * server (`lorekit_blog_like`, migration 00055) independently clamps a single
 * call to the same ceiling so no request can inflate the global total past one
 * session's worth.
 */

/** The maximum likes a single visitor/session may contribute to one post. */
export const MAX_SESSION_LIKES = 100;

/** `localStorage` key holding THIS session's contribution to a post's likes. */
export function sessionLikesKey(slug: string): string {
  return `lorekit:blog-likes:${slug}`;
}

/** Clamp an arbitrary number to the valid session-contribution range [0, MAX]. */
export function clampSessionLikes(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.trunc(n), 0), MAX_SESSION_LIKES);
}

/**
 * Parse a persisted session-likes value (possibly `null`, `undefined`, or
 * garbage) into a valid contribution count. Fail-safe: anything unparseable is
 * treated as "this session has liked zero times".
 */
export function parseSessionLikes(raw: string | null | undefined): number {
  if (raw == null) return 0;
  return clampSessionLikes(Number(raw));
}

/** Likes this session may still add before hitting the cap. */
export function remainingSessionLikes(sessionLikes: number): number {
  return MAX_SESSION_LIKES - clampSessionLikes(sessionLikes);
}

/** Whether this session has reached the per-session cap. */
export function isSessionMaxed(sessionLikes: number): boolean {
  return remainingSessionLikes(sessionLikes) <= 0;
}

/**
 * 0..1 "warmth" the heart fills toward as the session approaches the cap — the
 * visual cue that drives the button's colour intensity from a cool outline to a
 * fully saturated, glowing accent at 100.
 */
export function warmthRatio(sessionLikes: number): number {
  return clampSessionLikes(sessionLikes) / MAX_SESSION_LIKES;
}

/**
 * Clamp a to-be-sent delta to a single valid, non-zero increment. Mirrors the
 * server's `[1, 100]` clamp so an optimistic client and the authoritative RPC
 * never disagree on how much one flush may add.
 */
export function clampLikeDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 1;
  return Math.min(Math.max(Math.trunc(delta), 1), MAX_SESSION_LIKES);
}

/**
 * Human-readable total for the pill. Compact notation keeps the control small
 * as counts grow (`1234` → `1.2K`, `12000` → `12K`); small counts render plain.
 * Total function — a negative or non-finite input reads as `0`.
 */
export function formatLikeCount(n: number): string {
  const safe = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(safe);
}
