# supabase/functions/orgs/

REST API for organization management. All routes require a **Supabase JWT** — org RPCs resolve the caller via `auth.uid()` server-side and are unavailable to `lk_*` API token holders.

## URL patterns

All routes are relative to `/functions/v1/orgs`:

| Method | Path | Operation |
|--------|------|-----------|
| GET    | /    | List caller's orgs |
| POST   | /    | Create org |
| GET    | /:slug | Get org details |
| PATCH  | /:slug | Rename org |
| DELETE | /:slug | Soft-delete org (owner only) |
| GET    | /:slug/members | List members |
| PATCH  | /:slug/members/:userId | Change member role |
| DELETE | /:slug/members/:userId | Remove member (or leave if self) |
| GET    | /:slug/invites | List pending invites |
| POST   | /:slug/invites | Send invite |
| DELETE | /:slug/invites/:inviteId | Revoke invite |

## Slug → org_id pattern

Every mutation RPC takes `p_org_id` (UUID), not a slug. Handlers that need it
resolve the slug to org_id with a single `orgs.select('id').eq('slug', slug)` query
before calling the RPC. If the org is not found (or soft-deleted), return 404.

## Adding a handler

1. Create `handlers/{section}/{operation}.ts` following the existing pattern.
2. Import and wire it in `index.ts` router table with `requires: 'jwt'`.
3. Use `createTracedClient(db, span)` for all DB calls.
4. Return typed errors via `translateDbError(error)` before rethrowing.
