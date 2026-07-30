# _shared/api — REST utility modules

Nine modules shared by every REST edge function (`memories`, `orgs`, `openapi`), plus
the audit writer one level up in `_shared/audit.ts` (shared with `mcp` too — see
"Auditing" below).

## Import paths (from a function like `memories/`)

```typescript
import { resolveRestAuth } from '../_shared/api/auth.ts';
import { createRouter }    from '../_shared/api/router.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { ok, created, noContent, badRequest, unauthorized, forbidden,
         notFound, tooManyRequests, methodNotAllowed, internalError } from '../_shared/api/respond.ts';
import { validateBody, validateQuery, validateUuid } from '../_shared/api/validate.ts';
import { buildPage, encodeCursor, decodeCursor } from '../_shared/api/paginate.ts';
import { RestError, translateDbError } from '../_shared/api/errors.ts';
```

## Module reference

### auth.ts
- `resolveRestAuth(req, parentSpan)` — 3-tier auth: service key → lk_ API token → Supabase JWT. Returns `{ auth, db } | null`. Creates a `lorekit.rest.auth` child span.
- `hasPermission(auth, 'read' | 'write')` — returns true for service/user; checks `permissions` array for api_key.
- `isJwtAuth(auth)` — returns true only for JWT users (org endpoints require this).

### router.ts
- `createRouter(routes, functionName)` — returns `{ dispatch(req, resolved, span, cors) }`.
- Routes have `{ method, path, handler, requires: 'read' | 'write' | 'jwt' }`.
- Path params use `:name` syntax (e.g. `/:id`, `/:slug/members/:userId`).
- Dispatch creates a child span per handler call named `lorekit.{fn}.{method}.{path}`.

### cors.ts
- `corsHeaders(req)` — returns CORS headers; respects `ALLOWED_ORIGINS` env var.
- `handlePreflight(req)` — returns 204 with CORS headers for OPTIONS requests.
- Emits `Access-Control-Expose-Headers: traceparent`. Every response produced under
  `traceRequest` (`_shared/otel.ts`) carries a `traceparent` header built from the root
  SERVER span's `traceId`/`spanId` + sampled flag; without the expose header a browser
  cannot read it. `traceRequest` never mutates the handler's Response in place — it copies
  the headers and rebuilds the Response (status, statusText, body preserved), so an
  immutable or bodiless (204/304) Response is handled correctly.

### respond.ts
- Thin wrappers for every HTTP status. Always pass `cors` as the last argument.

### validate.ts
- `validateBody(req, schema, cors)` — async; parses JSON body against schema.
- `validateOptionalBody(req, schema, cors)` — async; as above, but an absent body parses as `{}` (for endpoints where every field has a default, e.g. `POST /memories/purge`). A present-but-malformed body is still a 400.
- `validateQuery(req, schema, cors)` — sync; parses URL search params.
- `validateUuid(id, cors)` — validates a UUID path param.
- All return `{ ok: true, data } | { ok: false, response }`.

### paginate.ts
- `buildPage(rows, limit)` — takes `limit+1` rows, returns `{ entries, hasMore, nextCursor }`.
- `encodeCursor(id, updatedAt)` / `decodeCursor(c)` — URL-safe base64 cursor.

### errors.ts
- `RestError` — extends Error, carries `status`, `code`, `details`. Call `.toResponse(cors)`.
- `translateDbError(err)` — maps Postgres SQLSTATE codes to `RestError` instances.

### filter.ts
- `applyFilter(query, filter)` — applies a `FilterGroup` (the OR+AND tree accepted by
  `POST /memories/search`) to a Supabase query builder. A no-op when `filter` is `undefined`.
- This module is a **thin adapter only**. The semantics — operator mapping, the field
  whitelist, and value encoding — live in `@lorekit/schemas/filter`'s
  `serializeFilterGroup`, next to the `FilterGroupSchema` that validates the input,
  so they are unit-tested in Node (`packages/schemas/src/filter.spec.ts`) and cannot
  drift from the schema. Add a new operator or filterable column **there**, not here.
- `serializeFilterGroup` returns an AND-list of PostgREST `or()` expressions; the adapter
  chains one `.or()` call per element, because PostgREST ANDs successive `.or()` calls.
- Fields outside `ALLOWED_FILTER_FIELDS` (`scope`, `key`, `value`, `tags`, `source_agent`,
  `trigger`) are dropped silently — a caller can never filter on `user_id`/`org_id` and
  subvert the tenant predicate applied separately by `tenant.ts`.

### tenant.ts
- `getMemberOrgIds(db, userId, span)` — resolves the caller's org memberships via
  `lorekit_member_org_ids`.
- `applyRestTenantScope(query, userId, orgIds)` — the widened tenant-visibility predicate
  for `api_key` auth (which uses a service-role client and therefore bypasses RLS).
  JWT auth needs no call: RLS enforces visibility. Never inline `.eq('user_id', …)` instead.

## Auditing — `_shared/audit.ts`

Lives one level up (`../audit.ts`, not `api/`) because the MCP function shares it:
`mcp/audit.ts` is now a thin re-export of the same module. One canonical Deno audit
writer, no duplication.

- `buildAuditEntry(input)` — pure; shapes the snake_case `audit_log` row.
- `recordAudit(db, input, userId)` — inserts it. Never throws.
- **`recordRestAudit(db, span, auth, input)`** — the one REST handlers should call.

The action vocabulary and the `AuditAction` / `AuditEntryInput` / `AuditRow` types come
from `@lorekit/schemas/audit` — the single source of truth shared with the Node writer,
the dashboard, and (restated in SQL) the `audit_log.action` CHECK constraint. The import
is **type-only** so the edge bundles don't gain the zod runtime for it.

### Rules

1. **Call it only AFTER the primary operation has succeeded.** Never on an error, 400,
   403, 404 or zero-rows-matched path. An audit row asserts a mutation happened; one
   written for a mutation that didn't is worse than none. Where an operation can no-op
   (a soft-archive matching no row, a purge that purged 0), audit only when the count
   proves it did something.
2. **Never make the response conditional on it.** It cannot throw, and a caller must not
   `try`/`catch` it or branch on it. A failed audit write must never fail the request.
3. **Actor resolution is `auth.userId ?? null`** — and it works better here than in MCP.
   `AuthContext.userId` is populated for JWT users (MCP's `getUserId` returns `null` for
   them), and the `audit_log` INSERT policy requires `user_id = auth.uid()`, which the
   RLS-scoped `type: 'user'` client satisfies. So REST records the real actor on JWT
   calls where MCP cannot. `api_key` records the token owner and `service` records
   `null`, both under a service-role client that bypasses RLS.
4. It creates a `lorekit.rest.audit` child span (like `lorekit.rest.auth` /
   `lorekit.rest.rate_limit`) so audit latency is attributable separately, carrying the
   bounded `lorekit.audit.action` attribute.
5. **Match the web server actions' field conventions** (`packages/web/src/lib/orgs.ts`,
   `org-invites.ts`) for the same operation, so the dashboard and REST surfaces produce
   comparable rows rather than two shapes for one event.

Every mutating REST route is required to call it — enforced by
`packages/mcp-core/src/rest-audit-usage.spec.ts`, which derives the handler set from the
route tables rather than a hardcoded list. A route registered `requires: 'read'` (e.g.
`POST /memories/search`) is exempt by construction.

```typescript
import { recordRestAudit } from '../../_shared/audit.ts';

const { count, error } = await q;
if (error) { span.error(`DB: ${error.message}`); throw error; }
if (!count) return notFound('Memory', cors);   // ← no audit: nothing happened

await recordRestAudit(db, span, auth, {
  action: force ? 'memory.delete' : 'memory.archive',
  resourceType: 'memory',
  resourceId: idParam ?? null,
  target: keyParam ?? idParam ?? null,
  metadata: { force, scope: scopeParam, key: keyParam },
});
return noContent(cors);
```

## Full example: memories/index.ts + one handler

```typescript
// memories/index.ts
import { traceRequest } from '../_shared/otel.ts';
import { resolveRestAuth } from '../_shared/api/auth.ts';
import { createRouter } from '../_shared/api/router.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
import { unauthorized, internalError } from '../_shared/api/respond.ts';
import { translateDbError, RestError } from '../_shared/api/errors.ts';
import { handleList } from './handlers/list.ts';

const router = createRouter([
  { method: 'GET', path: '/', handler: handleList, requires: 'read' },
], 'memories');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  const cors = corsHeaders(req);
  return traceRequest(req, 'lorekit.memories', async (span) => {
    const resolved = await resolveRestAuth(req, span);
    if (!resolved) return unauthorized(cors);
    try {
      return await router.dispatch(req, resolved, span, cors);
    } catch (e) {
      if (e instanceof RestError) return e.toResponse(cors);
      const mapped = translateDbError(e);
      if (mapped) return mapped.toResponse(cors);
      span.error(`Unhandled: ${(e as Error).message}`);
      return internalError(cors);
    }
  });
});
```

```typescript
// memories/handlers/list.ts
import type { AuthContext, DbClient } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { buildPage } from '../../_shared/api/paginate.ts';
import { createTracedClient } from '../../_shared/otel.ts';
import type { Span } from '../../_shared/otel.ts';
import { ListMemoriesQuerySchema } from '@lorekit/schemas/memory';

export async function handleList(
  req: Request, auth: AuthContext, db: DbClient, span: Span,
  _params: Record<string, string>, cors: Record<string, string>,
): Promise<Response> {
  const v = validateQuery(req, ListMemoriesQuerySchema, cors);
  if (!v.ok) return v.response;
  const tracedDb = createTracedClient(db, span);
  const { data, error } = await tracedDb.from('memories').select('*').limit(v.data.limit + 1);
  if (error) { span.error(error.message); throw error; }
  return ok(buildPage(data ?? [], v.data.limit), cors);
}
```
