# memories — REST memory CRUD

Handles all memory operations via HTTP. Auth is managed by the shared `resolveRestAuth` utility (service key, lk_ API token, or Supabase JWT).

## URL patterns

| Method | Path | Handler | Permission |
|--------|------|---------|------------|
| GET | / | list.ts | read |
| POST | / | create.ts | write |
| DELETE | / | remove.ts | write |
| POST | /search | search.ts | read |
| POST | /restore | restore.ts | write |
| POST | /purge | purge.ts | write |
| POST | /purge-expired | purge.ts | write |
| GET | /scopes | scopes.ts | read |
| GET | /:id | get.ts | read |
| PATCH | /:id | update.ts | write |
| DELETE | /:id | remove.ts | write |
| POST | /:id/restore | restore.ts | write |

**Route order is load-bearing.** `matchPath` (`_shared/api/router.ts`) matches on segment
count and returns *every* path match, then picks the first whose method matches — so
`/search`, `/restore`, `/purge`, `/purge-expired` and `/scopes` all collide with `/:id`.
The literal routes are registered before the `/:id` routes in `index.ts` so a future
`POST /:id` cannot silently swallow them.

## Archiving, restoring and deleting

| Intent | Request |
|--------|---------|
| List archived lore | `GET /?archived=true` — **this is the `memory.list-archived` equivalent**; there is no separate route. `?archived=false` (the default) lists only live, non-expired rows. |
| Archive (soft-delete) | `DELETE /:id` or `DELETE /?scope=…&key=…` → `204`. Stamps `archived_at`; the row stays recoverable. |
| Hard-delete | Add `?force=true` to either DELETE form → `204`. Performs a real row delete, is **irreversible**, and (unlike the archive path) also applies to already-archived rows. Mirrors the MCP `memory.delete` tool's `force` branch, down to the `lorekit.delete.force` span attribute. `force` accepts only the literal strings `true`/`false`; anything else is a `400`. |
| Archive/hard-delete **org-owned** lore | Add `?org=<slug>` to the `scope`+`key` DELETE form → `204`. See below. |

### `?org=<slug>` — the role-gated delete

`DELETE /?scope=…&key=…&org=<slug>` (optionally `&force=true`) targets lore owned by an
organization instead of the caller. It does **not** run the direct
`.delete()` / `.update()` the personal branch runs; it calls the `memory_delete` SECURITY
DEFINER RPC (`supabase/migrations/00020_memory_delete_org.sql`) with exactly the argument
set the MCP `memory.delete` tool uses — `p_user_id`, `p_org_slug`, `p_scope`, `p_key`,
`p_force`.

That is not a stylistic choice. The api_key tier reaches Postgres over a **service-role
client that bypasses RLS**, so a raw org-targeted query would have no role gate at all. The
gate (`lorekit_org_can` — `archive` for a soft-delete, `hard_delete` for `?force=true`)
lives inside the RPC and nowhere else.

Rules:

- **`org` requires `scope` + `key`.** The RPC is keyed on the natural key and has no id
  parameter, so `DELETE /:id?org=…` is a **400**, never a silent fall-through — ignoring
  `org` there would delete the caller's *personal* row while they believed they were
  deleting the org's.
- **A role denial is `LK002` → 403.** It is translated at the call site with
  `translateDbError` rather than left to bubble, so the mapping cannot be lost to a generic
  500 path.
- **An unresolvable slug raises `unknown_org` (P0001)** inside the RPC — same as
  `memory_write`.
- **The audit action comes from what the RPC reports it did** (`deleted` vs `archived`), not
  from the requested `force`, and metadata carries `org`. This mirrors `toolDelete` exactly.
- **`POST /restore` has no `org` form**, deliberately: the MCP `toolRestore` has no org
  branch either (it is a plain `.eq('user_id', …)` update). Restoring org-owned lore is an
  open gap on **both** surfaces; adding it to only one would break parity in the other
  direction.
| Restore | `POST /:id/restore`, or `POST /restore` with `{ "scope": …, "key": … }` → `200 { "restored": true }`. Only matches archived rows, so restoring a live row (or a nonexistent one) is a `404`. |
| Purge archived | `POST /purge` with an optional `{ "retention_days": 1–365 }` (default 30) → `200 { "purged": <n> }`. Body may be omitted entirely. |
| Purge expired | `POST /purge-expired` (no body) → `200 { "purged": <n> }`. |

## `created_at` on `POST /`

`created_at` is an **optional creation-date override** for the `lorekit migrate` backdating
case, and it is honoured (it used to be silently dropped — `p_created_at` was hard-coded to
`null`). The value is validated by `_shared/created-at.ts`'s `parseCreatedAt`, the very same
module the MCP `memory.write` tool uses: parseable date-time, normalised to ISO, and **rejected
if it is in the future** beyond a 60s clock-skew allowance. An invalid value is a `400` naming
the problem, never a silent drop and never a 500. Omitting the field leaves the DB's `now()`
default in place.

`ttl_minutes` / `ttl_seconds` remain **MCP-only**; REST accepts `ttl_days` only.

Both purge endpoints are user-scoped: they call RPCs keyed on `p_user_id`, so a
**service-role** token — which resolves no user — gets a `403`, not a `400`. The request is
well-formed; it is the credential that cannot name a purge target. Both are also
rate-limited on the same per-user window as `POST /` (a `429` carries `Retry-After`).

## `GET /scopes`

Returns every distinct scope the caller can see with its count of active (non-archived,
non-expired) memories, sorted by scope ascending:

```json
{ "scopes": [{ "scope": "global", "count": 12 }, { "scope": "repo::acme/app", "count": 3 }] }
```

The aggregation runs in Postgres (`lorekit_memory_scopes`, migration 00039), **not** as a
`select('scope')` plus a client-side `Set`. The client-side form is silently wrong past
PostgREST's default row cap: the response is truncated with no error, so whole scopes go
missing. Visibility inside the RPC composes `lorekit_member_org_ids` exactly as the
`memories` RLS read policies do, so personal and org-shared scopes both appear.

## Audit events

Every mutating handler writes to `audit_log` through **the one shared edge writer**,
`_shared/audit.ts` — the same `recordAudit` the MCP tools call (it was promoted out of
`mcp/audit.ts`; there is deliberately no second writer under `_shared/api/`).

| Handler | Action | Notes |
|---------|--------|-------|
| `create.ts` | `memory.create` / `memory.update` | Discriminated by the `inserted` flag `memory_write` returns (migration 00011), exactly as `toolWrite` does. Carries `resourceId`. |
| `update.ts` | `memory.update` | Only when the PATCH matched a row (a 404 audits nothing). |
| `remove.ts` | `memory.delete` (`?force=true`) / `memory.archive` | One event per affected row; `metadata.force` records which branch ran. The `?org=` form audits what the `memory_delete` RPC reported it did, not what was asked for. |
| `restore.ts` | `memory.restore` | Only when a row was actually un-archived. |
| `purge.ts` | `memory.delete` | One **summary** event per run (`target: "<n> archived memories"` / `"<n> expired memories"`), only when `purged > 0` — the RPCs return a count, not rows. |

Three invariants, all mirrored from the MCP side:

- **After, and only if it changed something.** The audit call comes after the primary
  operation committed, guarded the way the MCP tools guard on `if (archived)` / `if (deleted)` /
  `if (purged > 0)`.
- **It can never fail the request.** `recordAudit` does not throw; a failed insert is logged
  and swallowed.
- **The actor is auth-type-sensitive** (`auditUserId` in `_shared/api/auth.ts`, the REST twin of
  `mcp/auth.ts`'s `getUserId`): the resolved user for `api_key` callers, `null` for service-role
  **and** for user-JWT callers. On the JWT path the client is RLS-scoped and `audit_log`'s INSERT
  policy is `user_id = auth.uid()`, so a null actor fails RLS and the row is swallowed — the same
  documented limitation the MCP surface has (see the header of `_shared/audit.ts`). It is
  mirrored here on purpose rather than "fixed" on one surface only.

## `POST /search` body

| Field | Type | Notes |
|-------|------|-------|
| `q` | string | Full-text search over `fts` (websearch syntax, English config). |
| `scopes` | string[] | Exact-match `scope IN (...)`. |
| `tags` | string[] | Array overlap. |
| `filter` | FilterGroup | OR+AND tree — see below. |
| `limit` | 1–100 | Defaults to 50. |
| `cursor` | string | Keyset cursor from a previous page. |

At least one of `q`, `scopes` or `filter` is required; a body with none is a 400.

### The `filter` tree

A `FilterGroup` is recursively `{ and: FilterGroup[] } | { or: FilterGroup[] } | Condition`,
where a `Condition` is `{ field, op, value? }`. Operators: `is`, `is_not`, `contains`,
`does_not_contain`, `starts_with`, `ends_with`, `is_set`, `is_not_set`.

Filterable fields are whitelisted — `scope`, `key`, `value`, `tags`, `source_agent`,
`trigger`. A condition naming any other column is **dropped silently** (it is not an
error) so a caller can never filter on `user_id`/`org_id` and subvert tenant scoping.

```jsonc
{
  "filter": {
    "and": [
      { "field": "scope", "op": "is", "value": "global" },
      { "or": [
        { "field": "key",  "op": "contains", "value": "auth" },
        { "field": "tags", "op": "contains", "value": "pr-webhook" }
      ]}
    ]
  },
  "limit": 50
}
```

`filter` composes with `q`, `scopes` and `tags` — all are ANDed together. The translation
to PostgREST lives in `@lorekit/schemas/filter` (`serializeFilterGroup`), applied by
`_shared/api/filter.ts`; add operators or filterable columns in the schemas package.

## Auth rules

- API tokens (`lk_rw_*`) need `write` permission for POST/PATCH/DELETE.
- API tokens (`lk_ro_*`) work for GET/search.
- Service role key bypasses all tenant filters.
- JWT users see only their own memories plus org-shared memories.

## Adding a handler

1. Create `handlers/{name}.ts` exporting `async function handle{Name}(req, auth, db, span, params, cors)`.
2. Import in `index.ts` and add a route entry to the `createRouter` call.
3. Use `validateBody` / `validateQuery` / `validateUuid` from `_shared/api/validate.ts`.
4. Always create a child span: `span.child('lorekit.memories.{operation}')`.
5. Translate DB errors with `translateDbError` before re-throwing.
