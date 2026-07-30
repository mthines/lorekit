# _shared/api — REST utility modules

Seven modules shared by every REST edge function (`memories`, `orgs`, `openapi`).

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

### respond.ts
- Thin wrappers for every HTTP status. Always pass `cors` as the last argument.

### validate.ts
- `validateBody(req, schema, cors)` — async; parses JSON body against schema.
- `validateQuery(req, schema, cors)` — sync; parses URL search params.
- `validateUuid(id, cors)` — validates a UUID path param.
- All return `{ ok: true, data } | { ok: false, response }`.

### paginate.ts
- `buildPage(rows, limit)` — takes `limit+1` rows, returns `{ entries, hasMore, nextCursor }`.
- `encodeCursor(id, updatedAt)` / `decodeCursor(c)` — URL-safe base64 cursor.

### errors.ts
- `RestError` — extends Error, carries `status`, `code`, `details`. Call `.toResponse(cors)`.
- `translateDbError(err)` — maps Postgres SQLSTATE codes to `RestError` instances.

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
import { createClient } from 'npm:@supabase/supabase-js@2';
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
  const tracedDb = createTracedClient(db as ReturnType<typeof createClient>, span);
  const { data, error } = await tracedDb.from('memories').select('*').limit(v.data.limit + 1);
  if (error) { span.error(error.message); throw error; }
  return ok(buildPage(data ?? [], v.data.limit), cors);
}
```
