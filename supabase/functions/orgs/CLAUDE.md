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
- Service role key bypasses RLS but still routes through the same handlers.

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

## Audit events

Every mutating handler writes to `audit_log` via `recordRestAudit`
(`_shared/audit.ts`), **after** the RPC succeeds and never on an error/404 path. The
field layout deliberately matches the equivalent web server action
(`packages/web/src/lib/orgs.ts`, `org-invites.ts`) so the dashboard and the REST API
produce comparable rows for the same operation.

| Handler | Action | `resourceType` | `resourceId` | `target` | metadata |
|---------|--------|----------------|--------------|----------|----------|
| orgs/create.ts | `org.create` | `org` | new org id | org name | `{ slug }` |
| orgs/rename.ts | `org.rename` | `org` | org id | new name | — |
| orgs/remove.ts | `org.delete` | `org` | org id | — | — |
| members/remove.ts | `member.leave` (self) / `member.remove` | `org_member` | affected user id | org id | — |
| members/change-role.ts | `member.role_change` | `org_member` | affected user id | org id | `{ role }` |
| invites/create.ts | `member.invite` | `org_invite` | invite id | org id | `{ invitee, role }` |
| invites/revoke.ts | `member.revoke` | `org_invite` | invite id | — | — |

`members/remove.ts` picks its action from **the RPC that actually ran**, not the route:
the endpoint serves both "kick a member" (`lorekit_org_member_remove`) and "leave"
(`lorekit_org_leave`), and web audits those as `member.remove` and `member.leave`
respectively. Emitting `member.remove` for a self-removal would make one operation read
differently depending on which client performed it.

A failed audit write never fails the request — `recordRestAudit` cannot throw.
`packages/mcp-core/src/rest-audit-usage.spec.ts` fails if any mutating route here stops
calling it.

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
