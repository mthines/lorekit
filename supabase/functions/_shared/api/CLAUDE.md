# _shared/api/ — REST infrastructure for LoreKit Edge Functions

Shared utilities used by every `rest-*` Supabase Edge Function.
Import these with relative paths:

```ts
import { resolveAuth, getDb, canRead, canWrite, getUserId } from '../_shared/api/auth.ts';
import { ok, created, notFound, badRequest, tooManyRequests } from '../_shared/api/respond.ts';
import { validateBody, validateQuery, validateUuid, extractPathSegments } from '../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../_shared/api/paginate.ts';
import { checkRateLimit } from '../_shared/api/rate-limit.ts';
import { createRouter } from '../_shared/api/router.ts';
import { corsHeaders, handlePreflight } from '../_shared/api/cors.ts';
```

---

## Every handler file follows this exact shape

```ts
// rest-memories/handlers/list.ts
import type { AuthContext } from '../../_shared/api/auth.ts';
import { getDb, getUserId } from '../../_shared/api/auth.ts';
import { ok } from '../../_shared/api/respond.ts';
import { validateQuery } from '../../_shared/api/validate.ts';
import { buildPage, decodeCursor } from '../../_shared/api/paginate.ts';
import { MemoryListParamsSchema } from '../../_shared/schemas/memory.ts';
import type { Span } from '../../_shared/otel.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

export async function handleList(
  req: Request,
  auth: AuthContext,
  db: ReturnType<typeof createClient>,
  span: Span,
  _params: Record<string, string>,
): Promise<Response> {
  const parsed = validateQuery(req, MemoryListParamsSchema);
  if (!parsed.ok) return parsed.error;
  const p = parsed.data;

  const cursor = decodeCursor(p.cursor);
  // ... build query, apply tenant scope, call buildPage()
  return ok(page);
}
```

## Every index.ts follows this shape

```ts
// rest-memories/index.ts
import { traceRequest } from '../_shared/otel.ts';
import { resolveAuth, getDb } from '../_shared/api/auth.ts';
import { createRouter } from '../_shared/api/router.ts';
import { handlePreflight } from '../_shared/api/cors.ts';
import { unauthorized } from '../_shared/api/respond.ts';

import { handleList }   from './handlers/list.ts';
import { handleCreate } from './handlers/create.ts';
// ... other handlers

const router = createRouter('/rest-memories', [
  { method: 'GET',    pattern: '',        handler: handleList,   requires: 'read'  },
  { method: 'POST',   pattern: '',        handler: handleCreate, requires: 'write' },
  { method: 'GET',    pattern: '/:id',    handler: handleGet,    requires: 'read'  },
  { method: 'PATCH',  pattern: '/:id',    handler: handleUpdate, requires: 'write' },
  { method: 'DELETE', pattern: '/:id',    handler: handleRemove, requires: 'write' },
  { method: 'POST',   pattern: '/search', handler: handleSearch, requires: 'read'  },
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  return traceRequest(req, 'lorekit.rest.memories', async (span) => {
    const auth = await resolveAuth(req, span);
    if (!auth) return unauthorized();
    const db = getDb(auth);
    return router.dispatch(req, auth, db, span);
  });
});
```

---

## Utilities reference

### `auth.ts`
- `resolveAuth(req, span?)` → `AuthContext | null` — three-tier auth (service / api_key / jwt)
- `getDb(auth)` → Supabase client scoped to the auth tier
- `getUserId(auth)` → `string | null` — non-null for api_key only; pass to applyTenantScope
- `canRead(auth)` / `canWrite(auth)` — permission checks (the router gates on these)
- `isJwtAuth(auth)` — true only for JWT; required for org.* endpoints

### `respond.ts`
- `ok(data)` → 200 JSON
- `created(data)` → 201 JSON
- `noContent()` → 204 empty
- `badRequest(msg, fields?)` → 400 JSON `{ error: { code, message, fields? } }`
- `unauthorized(msg?)` → 401 JSON
- `forbidden(msg?)` → 403 JSON
- `notFound(msg?)` → 404 JSON
- `tooManyRequests(retryAfterSeconds, msg?)` → 429 JSON + `Retry-After` header
- `internalError(msg?)` → 500 JSON
- `fromError(err, context?)` → 500 — logs and returns internal error

### `validate.ts`
- `validateBody(req, schema)` → `Promise<ValidationResult<T>>` — parses JSON body
- `validateQuery(req, schema)` → `ValidationResult<T>` — parses URL query params
- `validateUuid(value, paramName?)` → `ValidationResult<string>` — validates UUID path param
- `extractPathSegments(req, prefix)` → `string[]` — splits path after prefix

All return `{ ok: true, data: T } | { ok: false, error: Response }`.
Check `result.ok` before using `result.data`:
```ts
const r = await validateBody(req, MySchema);
if (!r.ok) return r.error;  // already a 400 Response
const data = r.data;         // typed
```

### `paginate.ts`
- `decodeCursor(raw)` → `CursorPayload | null` — safe decode, returns null on error
- `encodeCursor(payload)` → `string` — base64url encode
- `buildPage(rows, limit, getCursorPayload)` → `Page<T>` — slice limit+1 rows into a page

Fetch `limit + 1` rows, pass all to `buildPage`. The extra row proves hasMore=true and is not returned.

### `rate-limit.ts`
- `checkRateLimit(db, userId, span, windowSeconds?)` → `RateLimitResult`
- Returns `{ allowed: true }` on RPC errors (fail open)
- Pass `userId = null` for service-role callers — they are exempt

Always call this before write operations:
```ts
const userId = getUserId(auth);
const rl = await checkRateLimit(db, userId, span);
if (!rl.allowed) return tooManyRequests(rl.retryAfterSeconds);
```

### `router.ts`
- `createRouter(prefix, routes)` → `{ dispatch(req, auth, db, span) }`
- Route patterns: `''` (root), `'/:id'`, `'/search'`, `'/:slug/members/:userId'`
- `requires: 'read' | 'write' | 'jwt'` — enforced before calling the handler

### `cors.ts`
- `corsHeaders(requestOrigin?)` → headers object — respects ALLOWED_ORIGINS env var
- `handlePreflight(req)` → 204 Response — call first in every Deno.serve handler

---

## Tenant scoping (critical security invariant)

api_key auth uses the service-role Supabase client (bypasses RLS). Every query
MUST scope to the caller's tenant:

```ts
import { applyTenantScope } from '../_shared/tenant-scope.ts';

const userId = getUserId(auth); // non-null for api_key
const orgIds = userId ? await memberOrgIds(db, userId) : [];
let q = db.from('memories').select('...');
if (userId) q = applyTenantScope(q, userId, orgIds);
```

JWT auth uses an RLS-scoped client — applyTenantScope is not needed (RLS handles it).

---

## Adding a new REST function

1. Create `supabase/functions/rest-{resource}/` directory
2. Add `index.ts` (router setup + Deno.serve), `handlers/` directory, `CLAUDE.md`
3. Add a `deno.json` in the function directory:
   ```json
   {
     "imports": {
       "npm:@supabase/supabase-js@2": "npm:@supabase/supabase-js@2",
       "npm:zod@3": "npm:zod@3"
     }
   }
   ```
   (Deno resolves relative `../` imports directly without a map entry.)
4. Register the function in `supabase/config.toml`:
   ```toml
   [functions.rest-{resource}]
   verify_jwt = false
   ```
5. Run `pnpm nx sync-to-shared schemas` to copy updated schemas to `_shared/schemas/`
6. Deploy: `pnpm nx fn:deploy supabase`
