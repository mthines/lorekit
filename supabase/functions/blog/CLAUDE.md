# blog — public blog like counter

The one **unauthenticated** REST function. The blog (`/blog/*` on lorekit.io) is a
public page and a like accumulates across all anonymous visitors, so this surface
has no Bearer token to resolve and no tenant to scope to.

## URL patterns

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| GET | /blog/likes?slug=… | likes.ts → `handleGetLikes` | **public** |
| POST | /blog/likes `{ slug, delta? }` | likes.ts → `handleAddLike` | **public** |

Both return `{ "likes": <global total> }`. `slug` is validated by
`@lorekit/schemas/blog` (`BlogSlugSchema`, lowercase kebab, ≤128) — a bad slug is a
`400`. `delta` defaults to 1 and is clamped to `[1,100]` by the schema and again,
authoritatively, by the `lorekit_blog_like` RPC.

## Why this function is different

- **No `resolveRestAuth`, no `createRouter`.** The shared router exists to gate a
  request by token tier and to record one per-user `usage_events` row. A public,
  anonymous counter has neither a permission tier nor a user, so this function does
  its own two-line dispatch instead. It still uses every other shared utility —
  `traceRequest`, `corsHeaders`/`handlePreflight`, `respond.ts`, `validate.ts`, the
  mirrored `_shared/schemas/blog.ts`.
- **Service-role DB client.** There is no user session to run under. Safe here only
  because the surface is minimal: the sole operations are reading and incrementing
  one global counter, and there is no per-tenant data reachable through them. Do NOT
  add a route that reads or writes tenant-scoped tables to this function — those
  belong in `memories`/`orgs`, behind auth.
- **`verify_jwt = false`** in `supabase/config.toml`, like `health` and `openapi`.

## Persistence

`blog_post_likes` (one row per slug) + the `lorekit_blog_like` SECURITY DEFINER RPC,
both granted to `anon` — see `supabase/migrations/00055_blog_post_likes.sql` and its
assertions in `supabase/tests/migrations.test.sql` §73. The per-session 100-like cap
is enforced **client-side** (the browser has no server identity); this function only
accumulates the global total and clamps a single call.
