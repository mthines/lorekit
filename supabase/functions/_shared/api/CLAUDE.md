# _shared/api — REST utility modules

Ten modules shared by every REST edge function (`memories`, `orgs`, `openapi`).

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
- `isJwtAuth(auth)` — returns true only for JWT users. **No route uses `requires: 'jwt'` any more** (the org routes were the last, until migration 00041); the helper stays for a future route that genuinely cannot be served without a user session.
- **`actorUserId(auth)`** — the actor to pass as `p_actor_user_id` to an org RPC. See below.
- `auditUserId(auth)` — the `audit_log.user_id` actor: **the resolved user for BOTH `api_key`
  and user-JWT callers, `null` only for service-role.** Re-exported from the pure, unit-tested
  `_shared/rest-audit-actor.ts` (mirror of `packages/mcp-core/src/audit/rest-audit-actor.ts`), so the
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

#### `actorUserId` — the org-RPC actor

Org RPCs resolve the acting user via `lorekit_org_actor(p_actor_user_id)`
(`supabase/migrations/00041_org_actor_override.sql`), which honours the parameter ONLY on a
verified `service_role` connection and otherwise falls back to `auth.uid()`. The api_key tier
talks to Postgres with the service-role key and so has no `auth.uid()` at all — without an
explicit actor, `lorekit_org_can(null, …)` denies every call.

```typescript
import { actorUserId } from '../../_shared/api/auth.ts';

const { error } = await tracedDb.rpc('lorekit_org_rename', {
  p_org_id: orgId,
  p_name: v.data.name,
  p_actor_user_id: actorUserId(auth),   // ← never `auth.userId ?? null` inline
});
```

Rules:

1. **Always the helper, never an inlined `auth.userId ?? null`.** Forgetting the argument breaks
   only the api_key tier, which no JWT-based test exercises — so the consistency has to be
   structural, not remembered. `packages/mcp-core/src/auth/org-actor-usage.spec.ts` enforces both the
   presence of `p_actor_user_id` and that it comes from `actorUserId`.
2. **It is not caller input.** `auth.userId` comes from the `api_tokens` row matched by token
   hash, or from the verified JWT — so a caller can only ever act as the identity its credential
   belongs to. The RPC-side half of that guarantee is that an `authenticated` caller's
   `p_actor_user_id` is ignored entirely; only the verified `role` claim unlocks it.
3. **`service` auth resolves to `null` and everything fails closed.** CI keeps its RLS bypass for
   direct table access but does not get to act as an anonymous org admin;
   `lorekit_org_create` raises LK002 rather than creating an ownerless org.
4. Three RPCs deliberately accept no override — `lorekit_org_invite_accept`,
   `lorekit_org_invite_decline`, `lorekit_org_leave`. Accept/decline match the invite against the
   caller's verified JWT identity claims, which service_role cannot supply.

### router.ts
- `createRouter(routes, functionName)` — returns `{ dispatch(req, resolved, span, cors) }`.
- Routes have `{ method, path, handler, requires: 'read' | 'write' | 'jwt' }`.
- Every route in `memories` and `orgs` is `read` or `write` today. `'jwt'` still exists but has no
  consumer: the org routes were the last, and migration 00041 plus the `tenant.ts` filters removed
  the need for it (see `orgs/CLAUDE.md`). The gating semantics themselves are unchanged.
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
  `_shared/rest-tool-name.ts` (mirror of `packages/mcp-core/src/rest/rest-tool-name.ts`), which maps
  each REST route onto the MCP tool name it is the equivalent of (`POST /memories` →
  `memory.write`) so the two surfaces aggregate as one series.   Guard: `auth.type !== 'service'`
  and a resolved user; there is no BYOD/`supportsHostedBilling` equivalent because the REST
  functions have no storage adapter and always target the hosted database.
- The response→`usage_events.outcome` classification is the pure, unit-tested
  `_shared/rest-response-outcome.ts` (`classifyResponseOutcome(status, bodyCode)`, mirror of
  `packages/mcp-core/src/rest/rest-response-outcome.ts`). Only the body read for the 429 cap-vs-rate
  split stays in the router — the decision itself is not inline here any more.

### cors-origins.ts
- The pure origin-matching half of CORS, mirrored from
  `packages/mcp-core/src/rest/cors-origins.ts` (the Deno edge function cannot cross-import the Node
  package). `edge-parity.spec.ts` compares the two copies' executable source with comments
  stripped, so they may document themselves differently but never behave differently, and
  `packages/mcp-core/src/rest/cors-origins.spec.ts` is their shared test home — `cors.ts` itself has
  none, which is why the decision lives here and not there.
- `expandOriginSiblings(origin)` — expands one configured origin to BOTH its apex and its `www.`
  host, so an allowlist naming only `https://lorekit.io` still admits the canonical
  `https://www.lorekit.io` the dashboard is served from (the apex 308-redirects to www). `*`
  passes through unchanged; an unparseable value is returned as-is.
- `expandAllowedOrigins(configured)` — the effective allowlist: `expandOriginSiblings` over every
  configured origin, deduplicated.
- `isOriginAllowed(allowed, origin)` — true when the expanded allowlist contains `*` or the exact
  origin, OR the origin is one of two always-admitted classes: a **loopback** dev host (`localhost` /
  `127.0.0.1` / `[::1]`, any port or scheme, exact host match), or one of the project's own **Vercel
  deployments** (`isVercelPreviewOrigin`: HTTPS, a single DNS label before exactly `.vercel.app`
  that BOTH starts with `lorekit-` AND ends with the Vercel account scope `-mads-thines-projects`
  — so every preview host `lorekit-git-<branch>-mads-thines-projects.vercel.app` and the
  `lorekit-mads-thines-projects.vercel.app` alias match, while `lorekit-x.attacker.vercel.app`,
  `lorekitten.vercel.app`, `lorekit.io` and a third-party `lorekit-x-<their-scope>.vercel.app`
  do not — the scope suffix is the half a third party cannot forge). Both are admitted independently of
  `ALLOWED_ORIGINS` because Vercel preview hostnames are per-deployment and cannot be enumerated
  into a static allowlist; safe because every request is Bearer-authenticated, so CORS is not the
  access control here — it only decides which browser origin may read the response.
- `corsResponseHeaders(allowed, origin)` — the static CORS headers plus
  `Access-Control-Allow-Origin` **only when the origin is allowed**. A disallowed origin gets no
  such header rather than an empty one: the empty string is not a valid header value and a browser
  reports it as a malformed response instead of a clean CORS rejection. A request with no `Origin`
  at all (server-to-server, curl) falls back to `*`, reachable only when the allowlist is itself a
  wildcard.

### cors.ts
- The env-reading shell over `cors-origins.ts`. It parses `ALLOWED_ORIGINS` (defaulting to
  `https://lorekit.io` when `VERCEL_ENV=production`, otherwise `*`), expands it once at module
  load with `expandAllowedOrigins`, and delegates every header decision. Do not reintroduce
  matching logic here — it would have no test home.
- `corsHeaders(req)` — `corsResponseHeaders(ALLOWED, req.headers.get('Origin') ?? '')`.
- `handlePreflight(req)` — returns 204 with CORS headers for OPTIONS requests.
- Emits `Access-Control-Expose-Headers: traceparent, X-LoreKit-Dry-Run`. Every response produced
  under `traceRequest` (`_shared/otel.ts`) carries a `traceparent` header built from the root
  SERVER span's `traceId`/`spanId` + sampled flag; without the expose header a browser
  cannot read it. `traceRequest` never mutates the handler's Response in place — it copies
  the headers and rebuilds the Response (status, statusText, body preserved), so an
  immutable or bodiless (204/304) Response is handled correctly.

### respond.ts
- Thin wrappers for every HTTP status. Always pass `cors` as the last argument.
- `dryRun(cors)` — 200 `{ dry_run: true }` + `X-LoreKit-Dry-Run: applied` header. Returned by a
  mutating handler when the request carries a truthy `X-LoreKit-Dry-Run` header: validate and
  authorize, then short-circuit BEFORE the write. The flag is parsed by `isDryRunHeader`
  (`_shared/dry-run.ts`, mirror of `packages/mcp-core/src/limits/dry-run.ts`); absent header ⇒ real
  execution, so existing clients are unaffected. Every mutating route must honour it — enforced by
  the source-scan `packages/mcp-core/src/limits/dry-run-coverage.spec.ts` (empty `DRY_RUN_EXEMPT`), the
  dry-run analogue of `audit-coverage.spec.ts`. The docs default the header to `true`
  (`X-LoreKit-Dry-Run` param on every mutating op, added centrally in `openapi/spec.ts`).

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
  so they are unit-tested in Node (`packages/schemas/src/shared/filter.spec.ts`) and cannot
  drift from the schema. Add a new operator or filterable column **there**, not here.
- `serializeFilterGroup` returns an AND-list of PostgREST `or()` expressions; the adapter
  chains one `.or()` call per element, because PostgREST ANDs successive `.or()` calls.
- Fields outside `ALLOWED_FILTER_FIELDS` (`scope`, `key`, `value`, `tags`, `source_agent`,
  `trigger`) are dropped silently — a caller can never filter on `user_id`/`org_id` and
  subvert the tenant predicate applied separately by `tenant.ts`.

### tenant.ts

Everything here exists for one reason: **`api_key` auth uses a service-role client, so RLS is
off**. A query that looks correctly scoped under a JWT returns every tenant's rows under a token.
All of these no-op for `user` (RLS already scopes it) and for `service` (CI keeps full access — do
not special-case it into a filter).

- `getMemberOrgIds(db, userId, span)` — resolves the caller's org memberships via
  `lorekit_member_org_ids`, the single tenant-visibility predicate. Fails closed to `[]`.
- `needsExplicitTenantFilter(auth)` — the one place the "is this the api_key tier?" test lives.
- `applyRestTenantScope(query, userId, orgIds, key?)` — the widened tenant-visibility predicate for
  `memories` reads. Never inline `.eq('user_id', …)` instead. The optional `key` is the calling API
  key's own restriction (00068/00069); the narrowing arithmetic is imported from the mirrored
  `_shared/tenant-scope.ts`, never re-implemented here, so the MCP and REST surfaces cannot disagree
  about what a key reaches.
- `applyKeyScopeFilter(query, auth)` — the allowlist half ALONE, for the personal-only write family
  (`PATCH`, `DELETE`, `POST /restore`). Those handlers deliberately never widen to org rows, so they
  do not call `applyRestTenantScope` — and without this they had no allowlist gate at all, letting a
  scoped key mutate an out-of-allowlist memory BY ID. A no-op for JWT/service and for an unrestricted
  key.
- `firstDeniedScope(auth, named)` — the first NAMED scope the calling key may not reach, or `null`.
  Use it when a request names a scope: a 403 is a better answer than an empty page, which reads as
  "there is nothing there". Reads that name no scope are narrowed by `applyRestTenantScope` instead.
  Every named scope must be allowed — answering over the allowed subset would answer a different
  question. Returns `null` for JWT/service callers and for an unrestricted key.
- `applyOwnMembershipFilter(query, auth)` — narrows an `org_members` query to the caller's own
  rows. `GET /orgs` is an unfiltered `from('org_members')` select; without this it returns every
  membership row in the database.
- `isOrgMember(db, auth, orgId, span)` — membership gate for a handler that resolves an org with
  a raw `from('orgs')` slug lookup. **Answer `false` with the same `notFound('Organization')` you
  return for a missing slug** — a 403 there leaks the org's existence to anyone who can guess it.
- `hasOrgCapability(db, auth, orgId, capability, span)` — asks `lorekit_org_can`, for a raw read
  whose JWT equivalent is a capability-based RLS policy (today only `org_invites`, whose
  `rls_org_invites_select_manage` shows rows to `invite`-capable callers only). Fails closed.

The org handlers' use of these is drift-guarded by
`packages/mcp-core/src/auth/org-actor-usage.spec.ts`; the MCP read path's use of `applyTenantScope` by
`tenant-scope-usage.spec.ts`.

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
