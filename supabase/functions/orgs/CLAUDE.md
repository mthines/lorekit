# orgs — REST org management

Handles all org operations via HTTP. Auth is managed by the shared `resolveRestAuth` utility.
**Every route accepts a Supabase JWT, a `lk_*` API token, or the service key** — gated by the
route's declared read/write permission, not by auth tier.

## URL patterns

| Method | Path | Handler | Permission |
|--------|------|---------|------------|
| GET | / | handlers/orgs/list.ts | read |
| POST | / | handlers/orgs/create.ts | write |
| GET | /:slug | handlers/orgs/get.ts | read |
| PATCH | /:slug | handlers/orgs/rename.ts | write |
| DELETE | /:slug | handlers/orgs/remove.ts | write |
| GET | /:slug/members | handlers/members/list.ts | read |
| PATCH | /:slug/members/:userId | handlers/members/change-role.ts | write |
| DELETE | /:slug/members/:userId | handlers/members/remove.ts | write |
| GET | /:slug/invites | handlers/invites/list.ts | read |
| POST | /:slug/invites | handlers/invites/create.ts | write |
| DELETE | /:slug/invites/:inviteId | handlers/invites/revoke.ts | write |

## Auth rules

These routes used to be `requires: 'jwt'`, so every `lk_*` token got a 403 and the CLI had to
keep an MCP transport alive purely for `org.create` / `org.list` / `org.rename` / `org.delete`.
They now accept API tokens. Two properties of the JWT client had to be replaced first, and BOTH
are load-bearing.

### 1. Token permission, not auth tier

`requires: 'read'` on GET, `requires: 'write'` on POST/PATCH/DELETE, checked by the router's
existing `hasPermission`. `lk_ro_*` may read and not write, `lk_wo_*` the reverse, `lk_rw_*` both.

**A token's permission is orthogonal to its holder's org role.** A `lk_rw_*` token owned by a
`viewer` still cannot rename the org — `lorekit_org_can` denies it and the LK002 surfaces as a
403. The token says what the CREDENTIAL may attempt; the org role says what the PERSON may do.

### 2. The actor override (`p_actor_user_id`, migration 00041)

Every org RPC resolved its actor as `auth.uid()`. The api_key tier reaches Postgres over a
SERVICE-ROLE connection where `auth.uid()` is NULL, so `lorekit_org_can(null, …)` denied
everything. `00041_org_actor_override.sql` adds a trailing `p_actor_user_id uuid default null` to
the eight RPCs this function calls, resolved through `lorekit_org_actor(p_actor_user_id)` — which
honours the parameter **only** when `auth.role() = 'service_role'`, a claim PostgREST copies out
of an already-verified JWT and never out of request input. An `authenticated` caller's
`p_actor_user_id` is ignored outright, so no client can impersonate anyone. Proven in
`supabase/tests/migrations.test.sql` §50–§59.

**Every handler passes `p_actor_user_id: actorUserId(auth)`** (`_shared/api/auth.ts`). Use the
helper, never an inlined `auth.userId ?? null`: omitting it breaks only the api_key tier, which is
invisible in a JWT test run. `packages/mcp-core/src/org-actor-usage.spec.ts` fails the build if a
call site drops it.

### 3. Reads MUST carry their own tenant filter

This is the dangerous half. `handleListOrgs` selects `org_members` with no filter and
`handleGetOrg` selects `orgs` by slug with no membership check; both were correct **only** because
RLS narrowed them. On the service-role client the api_key tier uses there is no RLS, so as written
`GET /orgs` would return every org in the database and `GET /orgs/:slug` would hand over any org
whose slug you can guess.

The helpers live in `_shared/api/tenant.ts` and all no-op for JWT and service callers:

| Helper | Use |
|--------|-----|
| `applyOwnMembershipFilter(q, auth)` | an `org_members` list query → the caller's own rows |
| `isOrgMember(db, auth, orgId, span)` | after a raw `from('orgs')` slug lookup |
| `hasOrgCapability(db, auth, orgId, cap, span)` | a raw read whose JWT equivalent is a `lorekit_org_can`-based RLS policy (today: `org_invites`) |

Rules:

- **A non-member gets the SAME `notFound('Organization')` as a non-existent slug.** Never a 403,
  never a different body. Any difference turns the route into an org-existence oracle over the
  whole slug namespace. This applies to the mutating handlers' slug lookups too, not just the
  reads.
- **Never special-case `auth.type === 'service'` into a filter.** Service-role (CI) keeps full
  access, exactly as it does in `memories`.
- Membership truth is `lorekit_member_org_ids` (via `getMemberOrgIds`) and the capability matrix
  is `lorekit_org_can` — never a hand-rolled `org_members` query here.
- `GET /:slug/invites` returns an empty list (200, not 403) to a member without the `invite`
  capability, because that is exactly what `rls_org_invites_select_manage` gives a JWT member.
  Matching it is what keeps the two tiers identical instead of quietly widening one.

`packages/mcp-core/src/org-actor-usage.spec.ts` fails if a handler reads
`orgs` / `org_members` / `org_invites` directly without referencing one of these helpers.

### Known gap — self-removal via an API token

`DELETE /:slug/members/:userId` routes self-removal to `lorekit_org_leave`, which 00041
deliberately left on a pure `auth.uid()` actor (alongside `_invite_accept` / `_invite_decline`,
which match the invite against verified JWT identity claims that service_role cannot supply). So
"leave an org" over an API token fails closed with LK002 → 403. It is a documented follow-up, not
an accident; the `ACTOR_EXEMPT_RPCS` entry in the drift guard records the reasoning.

## Router layout

The `index.ts` router dispatches to handler subdirectories:

```
handlers/
  orgs/       — top-level org CRUD (list, create, get, rename, remove)
  members/    — /:slug/members sub-resource (list, change-role, remove)
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
| members/change-role.ts | `lorekit_org_member_role` | Requires admin/owner; cannot assign owner |
| members/remove.ts | `lorekit_org_leave` or `lorekit_org_member_remove` | See note below. `_leave` takes NO actor override |

## Audit events

Every mutating handler writes to `audit_log` via `recordAudit`
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

A failed audit write never fails the request — `recordAudit` cannot throw.
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
