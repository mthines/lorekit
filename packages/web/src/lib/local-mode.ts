/**
 * Local web dev mode (plan D3) — the shared pieces `session-browser.ts`,
 * `session-server.ts`, `middleware.ts`, and `(dashboard)/layout.tsx` all need
 * to agree on: the two flag readers, the sentinel REST token, and the
 * synthetic user object the dashboard renders when there is no real Supabase
 * session to read.
 *
 * PLAN DEVIATION, recorded here and in `plan.md`'s Progress Log: the plan
 * named `middleware.ts` as the place that gates an unauthenticated dashboard
 * visit to `/login`. That gate actually lives in
 * `app/(dashboard)/layout.tsx` (via `lib/dashboard-bootstrap.ts`'s
 * `getUser` dependency, which calls `supabase.auth.getUser()` directly) —
 * `middleware.ts` only redirects an ALREADY-authenticated visitor away from
 * `/login`. Against the real local shim (which implements no GoTrue auth
 * endpoints at all), that real `getUser()` call would resolve to `null` and
 * the layout would redirect every request to a `/login` page that also has
 * no working auth backend — local mode would never render the dashboard.
 * Making AC-10 true requires one additional touch point,
 * `(dashboard)/layout.tsx`'s `getUser` callback — a single-line substitution,
 * not a hook/query/component logic change — reading `localUser()` from here
 * instead of the real `supabase.auth.getUser()` in local mode.
 *
 * Two flags (D3), never one: the browser bundle only ever sees the
 * build-inlined `NEXT_PUBLIC_LOREKIT_LOCAL_MODE` (so the Vercel production
 * bundle, which never sets it, cannot contain this branch); the server-only
 * runtime flag is `LOREKIT_LOCAL_MODE`. Both are read as literal
 * `process.env['…']` member expressions so Next.js can inline the client one.
 *
 * Zero business logic here — this module holds constants and two boolean
 * reads, nothing that touches React Query, a hook, or a component's render
 * output.
 */
import type { User } from '@supabase/supabase-js';

/** True when running under `lorekit serve` on the SERVER (Node process env). */
export function isLocalModeServer(): boolean {
  return process.env['LOREKIT_LOCAL_MODE'] === '1';
}

/** True when running under `lorekit serve` in the BROWSER bundle (build-inlined). */
export function isLocalModeBrowser(): boolean {
  return process.env['NEXT_PUBLIC_LOREKIT_LOCAL_MODE'] === '1';
}

/**
 * The sentinel Bearer token `session-browser.ts`/`session-server.ts` send to
 * the local REST shim. Its VALUE is never inspected by the shim (D3/D8 — one
 * implicit local user, no real JWT) — it only has to be a non-empty string
 * that survives being sent as `Authorization: Bearer <token>`.
 */
export const LOCAL_MODE_TOKEN = 'lorekit-local-dev-mode';

/**
 * The synthetic `User` the dashboard renders in local mode — enough of the
 * real `@supabase/supabase-js` `User` shape for `Sidebar`/`TopBar` (which read
 * `user.email`/`user.user_metadata`) and `Dash0Provider` (`user.id`) to render
 * without special-casing "no real session". There is exactly one local user
 * (D8), so this is a fixed constant, not derived from anything.
 */
export const LOCAL_MODE_USER: User = {
  id: '00000000-0000-0000-0000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'local@lorekit.dev',
  app_metadata: {},
  user_metadata: { full_name: 'Local dev' },
  created_at: new Date(0).toISOString(),
};
