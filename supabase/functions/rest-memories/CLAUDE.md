# rest-memories/ — Memory CRUD + search Edge Function

Handles all HTTP access to lorekit memories:

| Method | Path | Handler | Auth |
|---|---|---|---|
| GET | /rest-memories | list.ts | read |
| POST | /rest-memories | create.ts | write |
| POST | /rest-memories/search | search.ts | read |
| GET | /rest-memories/:id | get.ts | read |
| PATCH | /rest-memories/:id | update.ts | write |
| DELETE | /rest-memories/:id | remove.ts | write |

---

## Schema reference

Request/response shapes are defined in `_shared/schemas/memory.ts` (generated from `packages/schemas/src/memory.ts`):

| Schema | Used by |
|---|---|
| `WriteInputSchema` | POST /rest-memories (body) |
| `MemoryListParamsSchema` | GET /rest-memories (query) |
| `MemoryUpdateSchema` | PATCH /rest-memories/:id (body) |
| `MemorySearchBodySchema` | POST /rest-memories/search (body) |
| `MemoryResponseSchema` | All GET + PATCH responses |
| `MemoryWriteResponseSchema` | POST response |

---

## Auth rules

- Read endpoints: `lk_rw_*`, `lk_ro_*`, Supabase JWT, or service-role
- Write endpoints: `lk_rw_*`, `lk_wo_*`, Supabase JWT, or service-role
- API key (`lk_*`) auth uses the service-role client — EVERY query must go through
  `applyTenantScope()` from `_shared/tenant-scope.ts`
- JWT auth is RLS-scoped automatically — no extra filtering needed

---

## Natural key lookup

`GET /rest-memories?scope=global&key=my-lesson` acts as a natural key lookup —
returns at most one memory. This is how the CLI's `RemoteStore.read()` works after
migration to REST (instead of the MCP `memory.read` tool).

---

## Rate limiting

Write operations (create, update, delete) call `checkRateLimit()` before touching
the DB. Fails open (allows) on RPC error. Service-role callers are exempt.
Returns 429 + `Retry-After: N` header when limit is exceeded.

---

## Memory cap

The `memory_write` RPC raises `LK001` when the caller's memory cap is exceeded.
`handleCreate` translates this to a 429 response.

---

## Pagination

GET /rest-memories and POST /rest-memories/search use cursor-based pagination.
The cursor encodes `(updated_at, id)` — fetch one extra row to detect `hasMore`.

---

## Adding a handler

1. Create `handlers/your-handler.ts` following the pattern in existing handlers
2. Register it in `index.ts` with the correct method, pattern, and permission
3. Update the OpenAPI spec in `packages/schemas/src/openapi/spec.ts`
4. Run `pnpm nx generate:openapi schemas` to update `dist/openapi.json`
