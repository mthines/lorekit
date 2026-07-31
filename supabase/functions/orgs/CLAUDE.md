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

## Audit logging

**All seven mutating routes audit.** `POST /`, `PATCH /:slug`, `DELETE /:slug`,
`PATCH /:slug/members/:userId`, `DELETE /:slug/members/:userId`, `POST /:slug/invites` and
`DELETE /:slug/invites/:inviteId` each call `recordAudit(db, {...}, auditUserId(auth))` from
`_shared/audit.ts` — the single edge audit writer — **after** the RPC succeeded, never on a
validation, 404, permission or RPC-error path. Every `lorekit_org_*` RPC RAISES on each of its
non-success branches, so `error === null` is a reliable "a row really changed".

This reverses the earlier decision that the orgs handlers were deliberately un-audited. That
decision was correct **only** while `auditUserId` returned `null` for JWT callers: every org
route is `requires: 'jwt'`, so a null actor failed `rls_audit_log_insert`'s
`user_id = auth.uid()` check and the insert was swallowed — wiring them then would have added
guaranteed-dead code. `auditUserId` now returns the JWT caller's own id, which is exactly what
that policy requires, so the rows land and the exemption is gone.

The `action`/`resourceType`/`resourceId`/`target`/`metadata` shapes deliberately MATCH the
equivalent dashboard server actions (`packages/web/src/lib/orgs.ts`,
`packages/web/src/lib/org-invites.ts`) so the REST and dashboard surfaces produce comparable
rows. Do not invent a new shape for a route that already has a dashboard twin.

`DELETE /:slug/members/:userId` records **`member.leave`** when the target is the caller and
**`member.remove`** otherwise — the same self-vs-other split that already chooses between
`lorekit_org_leave` and `lorekit_org_member_remove`.

A new mutating route is required to audit by the structural guard
`packages/mcp-core/src/audit-coverage.spec.ts`, which parses this file's route table, resolves
each handler through `index.ts`'s own imports, and fails if the file has no `recordAudit` call.

## Adding a handler

1. Create the file under the appropriate subdir (e.g. `handlers/members/newaction.ts`) exporting `async function handle{Name}(req, auth, db, span, params, cors)`.
2. Import in `index.ts` and add a route entry to the `createRouter` call.
3. Use `validateBody` / `validateQuery` / `validateUuid` / `validateSlug` from `_shared/api/validate.ts`.
4. Always create a child span: `span.child('lorekit.orgs.{operation}')`.
5. Translate DB errors with `translateDbError` before re-throwing.
