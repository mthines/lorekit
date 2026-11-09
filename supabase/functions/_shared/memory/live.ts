/**
 * The PostgREST `.or()` filter that keeps only UNEXPIRED rows: no expiry, or
 * one still in the future. An expired memory is absent to every by-id route —
 * `GET /:id` 404s on it, and `memory_write` (00120) counts it as version 0 —
 * so `PATCH /:id` uses the same predicate, and the two cannot drift apart.
 * Pair it with `.is('archived_at', null)` for "live".
 */
export const NOT_EXPIRED = 'expires_at.is.null,expires_at.gt.now()';
