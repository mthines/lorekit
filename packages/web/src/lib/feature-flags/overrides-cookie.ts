/**
 * The session-override cookie — the transport for `@lorekit/feature-flags`'
 * transport-agnostic `parseFlagOverrides`/`serializeFlagOverrides` (see
 * `packages/feature-flags/src/overrides.ts`).
 *
 * `httpOnly`: nothing reads or writes this cookie from browser JS. Writes go
 * through the Server Actions in `overrides-actions.ts` (a form submission,
 * not a `document.cookie` mutation), and reads happen server-side in
 * `server.ts`. That is what lets the override apply identically to server
 * AND client — the client never has its own copy of the override state to
 * disagree with; it only ever sees values `FeatureFlagsProvider` was handed
 * by a Server Component that already read this cookie.
 */
export const FLAG_OVERRIDES_COOKIE = 'lorekit_flag_overrides';

/** One day — deliberately short. An override is a debugging aid, not a durable preference. */
export const FLAG_OVERRIDES_MAX_AGE_SECONDS = 60 * 60 * 24;
