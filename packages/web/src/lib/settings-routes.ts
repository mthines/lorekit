/**
 * Canonical Settings route constants.
 *
 * `/settings` has no content of its own — it is an alias for the first section.
 * It used to be served by a Server Component that called `redirect()` at render
 * time. That made every "go to Settings" click a client-side redirect hop:
 * the app router rendered `/settings`, fetched its RSC payload, learned it was
 * a redirect, then swapped in `/settings/api-keys`. Resolving that hop crashed
 * React inside Next's own `app-router` with "Minified React error #310"
 * (Rendered more hooks than during the previous render) — a fatal, uncaught
 * browser error observed on `/settings` and nowhere else.
 *
 * The redirect now lives in `next.config.ts`, where it is resolved at the
 * routing layer (an HTTP redirect) before React renders anything, and internal
 * navigation targets {@link SETTINGS_LANDING_HREF} directly so the hop never
 * happens at all.
 */

/**
 * Root of the Settings area. Used for active-state matching only — never as a
 * navigation target, because it is the route that has to be redirected away.
 */
export const SETTINGS_ROOT = '/settings';

/**
 * Where "Settings" actually goes: the first section in the settings nav. Every
 * internal link and `router.push` for Settings must use this, not
 * {@link SETTINGS_ROOT}.
 */
export const SETTINGS_LANDING_HREF = '/settings/api-keys';

/** True when `pathname` is the Settings root or any route nested under it. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_ROOT || pathname.startsWith(`${SETTINGS_ROOT}/`);
}
