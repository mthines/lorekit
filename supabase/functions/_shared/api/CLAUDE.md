# _shared/api — REST utility modules

Nine modules shared by every REST edge function (`memories`, `orgs`, `openapi`).

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
- `auditUserId(auth)` — the `audit_log.user_id` actor: **the resolved user for BOTH `api_key`
  and user-JWT callers, `null` only for service-role.** Re-exported from the pure, unit-tested
  `_shared/rest-audit-actor.ts` (mirror of `packages/mcp-core/src/rest-audit-actor.ts`), so the
  rule has a test home — this file has none.
  **It used to return `null` for JWT callers, and that was a bug, not a design.** A JWT caller
  gets `userClient(jwt)` (ANON_KEY + `Authorization: Bearer <jwt>`), so RLS applies and
  `auth.uid()` is that user's id; `audit_log`'s insert policy is
  `rls_audit_log_insert … with check (user_id = auth.uid())` (migration 00010). Passing the
  caller's own id is what makes the insert legal; passing `null` violated the policy, and
  `recordAudit` — correctly non-throwing — swallowed the rejection, so every JWT-authenticated
  REST mutation silently lost its audit row. Service-role stays `null`: no human actor, and that
  client bypasses RLS anyway.
  **Cross-surface consequence:** REST now attributes JWT callers correctly where MCP
  (`mcp/auth.ts`'s `getUserId`) still records `null` and still loses those rows. `getUserId` is
  the side that should converge on this rule — do not "restore symmetry" by reverting REST.
- `analyticsUserId(auth)` / `usageAuthType(auth)` — the `usage_events` actor and auth-type
  labels. `analyticsUserId` is `null` for service-role, which is why a service-role caller
  records no usage events at all.

### router.ts
- `createRouter(routes, functionName)` — returns `{ dispatch(req, resolved, span, cors) }`.
- Routes have `{ method, path, handler, requires: 'read' | 'write' | 'jwt' }`.
- Path params use `:name` syntax (e.g. `/:id`, `/:slug/members/:userId`).
- Dispatch creates a child span per handler call named `lorekit.{fn}.{method}.{path}`.
- **`requires: 'jwt'` rejects the service-role key as well as `lk_*` tokens** — the gate is
  `isJwtAuth`, true only for `type === 'user'`. A service credential has no `auth.uid()`, which
  is what those routes actually need.
- **Dispatch is the one place REST usage events are recorded** (`usage_events`, migration 00034),
  on both the returned-response and the thrown-error path — the structural analogue of
  `mcp/mcp-handler.ts`'s per-tool-call recording. One site covers every current and future route;
  a per-handler call is one the next handler forgets. The writer is `_shared/usage.ts`
  (`recordUsageEvent` / `getUserPlanName`), shared with the MCP handler — `mcp/limits.ts`
  re-exports it, it is not a second copy. The route→`tool_name` mapping is the pure, unit-tested
  `_shared/rest-tool-name.ts` (mirror of `packages/mcp-core/src/rest-tool-name.ts`), which maps
  each REST route onto the MCP tool name it is the equivalent of (`POST /memories` →
  `memory.write`) so the two surfaces aggregate as one series.   Guard: `auth.type !== 'service'`
  and a resolved user; there is no BYOD/`supportsHostedBilling` equivalent because the REST
  functions have no storage adapter and always target the hosted database.
- The response→`usage_events.outcome` classification is the pure, unit-tested
  `_shared/rest-response-outcome.ts` (`classifyResponseOutcome(status, bodyCode)`, mirror of
  `packages/mcp-core/src/rest-response-outcome.ts`). Only the body read for the 429 cap-vs-rate
  split stays in the router — the decision itself is not inline here any more.

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
