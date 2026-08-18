/**
 * Which paths require a session — the one list the auth gate reads.
 *
 * The gate used to live in `app/(dashboard)/layout.tsx`, where it needed no
 * list at all: the `(dashboard)` route group IS the boundary, so a page was
 * protected by virtue of the directory it sat in. That is a genuinely nicer
 * property, and moving the gate into middleware gives it up — middleware sees
 * a pathname, not a route group.
 *
 * It is given up on purpose. The layout gate could not see the request's query
 * string (the App Router does not pass `searchParams` to a layout, and a layout
 * cannot reach the raw `Request`), so preserving a shared link through login
 * meant middleware copying the whole URL into an `x-search` REQUEST HEADER for
 * the layout to read back and re-encode. That copy is what turned a wide Lore
 * Explorer filter bar into a `431 Request Header Fields Too Large`, and it
 * existed only to feed a second gate re-deciding what middleware — which
 * already calls `getUser()` to refresh the session cookie — had just decided.
 *
 * So the list is the cost of deleting the header, and `protected-routes.spec.ts`
 * pays it down: it reads `app/(dashboard)` off disk and fails if this array and
 * the filesystem disagree. Adding a dashboard route without adding it here is a
 * failing test, not a page that silently stopped requiring a login.
 */

/**
 * Top-level segments under `app/(dashboard)`, which is exactly the set of
 * paths the dashboard layout used to gate.
 *
 * Kept in sync with the filesystem by the drift guard in the spec beside this
 * file. Do not hand-edit one without the other.
 */
export const PROTECTED_SEGMENTS = [
  'lore',
  'onboarding',
  'overview',
  'settings',
  'tutorials',
] as const;

/**
 * Whether a pathname sits behind the auth gate.
 *
 * Prefix matching on a SEGMENT boundary, so `/lore` and `/lore/abc` are both
 * protected while a hypothetical `/lorem-ipsum` marketing page is not — a
 * bare `startsWith` would have swallowed it.
 */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_SEGMENTS.some(
    (segment) => pathname === `/${segment}` || pathname.startsWith(`/${segment}/`),
  );
}
