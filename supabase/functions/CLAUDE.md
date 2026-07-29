# supabase/functions/ — Edge Function conventions

LoreKit runs on Supabase Edge Functions (Deno). Two categories:

| Function | Purpose |
|---|---|
| `mcp/` | Production MCP server — all `memory.*` and `org.*` tools |
| `health/` | Public health check |
| `rest-memories/` | REST API for memories (CRUD + search) |
| `rest-orgs/` | REST API for orgs, members, invites |
| `rest-openapi/` | Serves the OpenAPI 3.1 spec + Swagger UI |

---

## Shared code

All Edge Functions share two directories under `_shared/`:

| Path | Contents |
|---|---|
| `_shared/otel.ts` | OTel tracing: `traceRequest()`, `createTracedClient()`, span helpers |
| `_shared/scope.ts` | Scope validation: `validateScope()`, `UserInputError` |
| `_shared/schemas/` | **Generated.** Copied from `packages/schemas/src/` by `sync-schemas-to-shared.mjs`. Do NOT edit directly. |
| `_shared/api/` | REST infrastructure: auth, respond, validate, paginate, rate-limit, router, cors |

### Importing shared code

```ts
// From within any function (e.g. rest-memories/handlers/list.ts):
import { traceRequest } from '../../_shared/otel.ts';
import { resolveAuth, getDb } from '../../_shared/api/auth.ts';
import { WriteInputSchema } from '../../_shared/schemas/memory.ts';
```

---

## Adding a REST function

1. `mkdir supabase/functions/rest-{resource}`
2. Create `index.ts`, `handlers/`, `CLAUDE.md` — see `_shared/api/CLAUDE.md` for the template
3. Add to `supabase/config.toml`:
   ```toml
   [functions.rest-{resource}]
   verify_jwt = false
   ```
4. Run `pnpm nx sync-to-shared schemas` if you changed schemas
5. Deploy: `pnpm nx fn:deploy supabase`

---

## MCP function

The `mcp/` function is self-contained (no cross-package imports).
Several modules in `mcp/` are mirrors of `packages/mcp-core/src/` modules:
`limits.ts`, `tenant-scope.ts`, `auth-token.ts`, `org-permissions.ts`, etc.
These mirrors are kept in sync by `packages/mcp-core/src/edge-parity.spec.ts`.

Do NOT add imports of `_shared/api/` into `mcp/` — the MCP function predates
the shared REST infrastructure and has its own copies of auth, limits, etc.
The `_shared/api/auth.ts` was extracted FROM `mcp/auth.ts`; the MCP function
continues using its own local copy.

---

## Deno runtime notes

- Use `npm:` prefix for npm packages: `import { createClient } from 'npm:@supabase/supabase-js@2'`
- Use `npm:zod@3` for Zod
- No `require()` — ESM only
- `Deno.env.get('KEY')` instead of `process.env.KEY`
- Relative imports from `_shared/` work at both serve and deploy time

---

## OTel tracing

Every function entry point wraps its handler in `traceRequest()`:

```ts
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handlePreflight(req);
  return traceRequest(req, 'lorekit.rest.memories', async (span) => {
    // ... handler logic
  });
});
```

Propagate incoming `traceparent` headers automatically — `traceRequest()` reads
the W3C `traceparent` header and links the incoming distributed trace. This means
CLI and mcp-server callers that forward their `traceparent` will see the full
`CLI → REST → Supabase` trace in Dash0.

---

## Config

```toml
# supabase/config.toml

[functions.mcp]
verify_jwt = false   # auth handled inside the function

[functions.health]
verify_jwt = false

[functions.rest-memories]
verify_jwt = false

[functions.rest-orgs]
verify_jwt = false

[functions.rest-openapi]
verify_jwt = false
```

---

## Deployment

```bash
# Deploy all functions
pnpm nx fn:deploy supabase

# Sync schemas first if they changed
pnpm nx sync-to-shared schemas && pnpm nx fn:deploy supabase
```
