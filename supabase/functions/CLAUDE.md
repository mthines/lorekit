# LoreKit Supabase Edge Functions

## Function naming
Functions are named after their domain resource: `memories`, `orgs`, `openapi`.
No `api-` or `rest-` prefix — transport and layer are implementation details, not names.
The existing `mcp` and `health` functions are unchanged. `profiling` is an
operator surface rather than a tenant resource — service-role only, not part of
the public REST contract, and deliberately absent from `openapi`.

## Adding a new REST function

1. Create `supabase/functions/{resource}/index.ts` following the pattern in `memories/index.ts`
2. Create `supabase/functions/{resource}/handlers/*.ts` for each method+path combination
3. Add `[functions.{resource}]\nverify_jwt = false` to `supabase/config.toml`
4. Document in this file

## Shared utilities

All shared code lives in `_shared/`. Import paths from a function:
- `import { traceRequest } from '../_shared/telemetry/otel.ts'` — OTel root span
- `import { resolveRestAuth } from '../_shared/api/auth.ts'` — 3-tier auth
- `import { createRouter } from '../_shared/api/router.ts'` — method+path dispatch
- See `_shared/api/CLAUDE.md` for the full reference

## Schemas

All Zod schemas live in `packages/schemas/` (@lorekit/schemas). Import via the import map:
- `import { MemoryWriteSchema } from '@lorekit/schemas/memory'`
- `import { CreateOrgBodySchema } from '@lorekit/schemas/org'`

## Telemetry

Every function calls `traceRequest(req, 'lorekit.{resource}', ...)` as the root span.
Auth resolution creates a `lorekit.rest.auth` child span automatically.
Router creates a child span per handler call named `lorekit.{function}.{method}.{path}`.
DB operations get child spans automatically via `createTracedClient`.
Add `span.child('lorekit.{resource}.{operation}')` for any significant sub-operation.

**Self-time attribution is automatic.** `traceRequest` stamps
`lorekit.io.wait_ms` / `lorekit.io.calls` / `lorekit.self_time_ms` on every root
span — the split between waiting on Postgres and running our own code. It is fed
by span KIND: anything opened as `SPAN_KIND_CLIENT` counts as an outbound call,
so wrapping a raw `fetch` in `span.child(name, attrs, SPAN_KIND_CLIENT)` is
enough to have it attributed. Intervals are MERGED, not summed (concurrent
queries count once) — see `_shared/telemetry/io-ledger.ts`.

**Metrics** go through `_shared/telemetry/otlp-metrics.ts`, which imports its resource
attributes, endpoint and encoding from `_shared/telemetry/otel.ts`. Never build a second
resource-attribute list: a metric on a different resource than the spans beside
it silently stops correlating in Dash0.

The `profiling` function is the operator surface for query-level profiling
(`pg_stat_statements` → Dash0 metrics). It is service-role ONLY and deliberately
does not use `createRouter` — a cron poke is not a tenant request and must not
land in `usage_events`. See [docs/otel.md](../../docs/otel.md) →
"Query-level profiling".

## Deploying
`pnpm nx fn:deploy supabase` — deploys all functions.
