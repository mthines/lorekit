# LoreKit Supabase Edge Functions

## Function naming
All REST API functions are prefixed `api-`: `api-memories`, `api-orgs`, `api-openapi`.
The existing `mcp` and `health` functions are unchanged.

## Adding a new REST function

1. Create `supabase/functions/api-{resource}/index.ts` following the pattern in `api-memories/index.ts`
2. Create `supabase/functions/api-{resource}/handlers/*.ts` for each method+path combination
3. Add `[functions.api-{resource}]\nverify_jwt = false` to `supabase/config.toml`
4. Document in this file

## Shared utilities

All shared code lives in `_shared/`. Import paths from a function:
- `import { traceRequest } from '../_shared/otel.ts'` — OTel root span
- `import { resolveRestAuth } from '../_shared/api/auth.ts'` — 3-tier auth
- `import { createRouter } from '../_shared/api/router.ts'` — method+path dispatch
- See `_shared/api/CLAUDE.md` for the full reference

## Schemas

All Zod schemas live in `packages/schemas/` (@lorekit/schemas). Import via the import map:
- `import { MemoryWriteSchema } from '@lorekit/schemas/memory'`
- `import { CreateOrgBodySchema } from '@lorekit/schemas/org'`

## Telemetry

Every function calls `traceRequest(req, 'lorekit.api-{resource}', ...)` as the root span.
Auth resolution creates a `lorekit.rest.auth` child span automatically.
Router creates a child span per handler call named `lorekit.{function}.{method}.{path}`.
DB operations get child spans automatically via `createTracedClient`.
Add `span.child('lorekit.rest.{operation}')` for any significant sub-operation.

## Deploying
`pnpm nx fn:deploy supabase` — deploys all functions including new api-* ones.
