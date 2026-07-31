# orgs — REST org management

Handles all org operations via HTTP. Auth is managed by the shared `resolveRestAuth` utility. **Org endpoints require a Supabase JWT — `lk_*` API key tokens receive 403.**

## URL patterns

| Method | Path | Handler | Permission |
|--------|------|---------|------------|
| GET | / | handlers/orgs/list.ts | JWT only |
| POST | / | handlers/orgs/create.ts | JWT only |
| GET | /:slug | handlers/orgs/get.ts | JWT only |
| PATCH | /:slug | handlers/orgs/rename.ts | JWT only |
| DELETE | /:slug | handlers/orgs/remove.ts | JWT only |
| GET | /:slug/members | handlers/members/list.ts | JWT only |
| PATCH | /:slug/members/:userId | handlers/members/role.ts | JWT only |
| DELETE | /:slug/members/:userId | handlers/members/remove.ts | JWT only |
| GET | /:slug/invites | handlers/invites/list.ts | JWT only |
| POST | /:slug/invites | handlers/invites/create.ts | JWT only |
| DELETE | /:slug/invites/:inviteId | handlers/invites/revoke.ts | JWT only |

## Auth rules

- **JWT required** — all org endpoints call RPCs that enforce `auth.uid()` server-side.
- `lk_*` API tokens (read-only or read-write) are rejected with 403; orgs are personal/team resources tied to a user identity.
- **The service-role key is rejected too — it never reaches a handler.** Every route here is
  `requires: 'jwt'`, and the router's gate is `isJwtAuth(auth)` (`_shared/api/router.ts`), which
  is true **only** for `auth.type === 'user'` (`_shared/api/auth.ts`). `resolveRestAuth` resolves
  the service-role key to `type: 'service'`, so it fails that gate and gets
  `403 "This endpoint requires a Supabase JWT (not an API token)"` — the same refusal an `lk_*`
  token gets. This is correct, not an oversight: a service-role client has no session JWT, so
  `auth.uid()` is null inside every `lorekit_org_*` SECURITY DEFINER RPC these handlers call, and
  the RPC would refuse (or, worse, mis-attribute) the action anyway. Bypassing RLS is irrelevant
  here — these endpoints are gated on *having an identity*, not on row visibility.

## Router layout

The `index.ts` router dispatches to handler subdirectories:

```
handlers/
  orgs/       — top-level org CRUD (list, create, get, rename, remove)
  members/    — /:slug/members sub-resource (list, role, remove)
  invites/    — /:slug/invites sub-resource (list, create, revoke)
```

Handler signature: `async function handle{Name}(req, auth, db, span, params, cors)`.

## RPC calls

| Handler | RPC | Notes |
|---------|-----|-------|
| orgs/create.ts | `lorekit_org_create` | Creates org + owner membership in one call |
| orgs/rename.ts | `lorekit_org_rename` | Requires admin/owner role |
| orgs/remove.ts | `lorekit_org_delete` | Requires owner role; soft-deletes |
| invites/create.ts | `lorekit_org_invite` | Sends invite by email; requires admin/owner |
| invites/revoke.ts | `lorekit_org_invite_revoke` | Requires admin/owner |
| members/role.ts | `lorekit_org_member_role` | Requires owner to change roles |
| members/remove.ts | `lorekit_org_leave` or `lorekit_org_member_remove` | See note below |

## Self-removal routing in `members/remove.ts`

`DELETE /:slug/members/:userId` is used for both **kicking a member** (admin/owner) and **leaving an org** (any member). The handler checks:

```typescript
if (params.userId === auth.userId) {
  // Self-removal — call lorekit_org_leave
} else {
  // Removing another member — call lorekit_org_member_remove (requires admin/owner)
}
```

This keeps the URL surface minimal while preserving correct permission semantics.

## Adding a handler

1. Create the file under the appropriate subdir (e.g. `handlers/members/newaction.ts`) exporting `async function handle{Name}(req, auth, db, span, params, cors)`.
2. Import in `index.ts` and add a route entry to the `createRouter` call.
3. Use `validateBody` / `validateQuery` / `validateUuid` / `validateSlug` from `_shared/api/validate.ts`.
4. Always create a child span: `span.child('lorekit.orgs.{operation}')`.
5. Translate DB errors with `translateDbError` before re-throwing.
