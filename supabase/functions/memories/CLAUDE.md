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
| Restore | `POST /:id/restore`, or `POST /restore` with `{ "scope": …, "key": … }` → `200 { "restored": true }`. Only matches archived rows, so restoring a live row (or a nonexistent one) is a `404`. |
| Purge archived | `POST /purge` with an optional `{ "retention_days": 1–365 }` (default 30) → `200 { "purged": <n> }`. Body may be omitted entirely. |
| Purge expired | `POST /purge-expired` (no body) → `200 { "purged": <n> }`. |

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

**No audit events.** None of these handlers write to `audit_log` — the REST surface has no
audit writer at all (there is no `_shared` equivalent of `mcp/audit.ts`, and `create.ts` /
`update.ts` do not audit either). The MCP tools do. Closing that gap is a separate change;
do not add a second, divergent audit path from one handler.

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
