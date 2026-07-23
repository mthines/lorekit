# LoreKit — Agent Context

## What this project is

NX monorepo containing a Supabase-backed MCP server for shared, persistent agent memory. Agents read and write lessons via standard MCP tool calls; memories are stored in Postgres with row-level security.

## Package map

| Package | Path | Role |
| ------- | ---- | ---- |
| `@lorekit/core` | `packages/mcp-core/` | Tool handlers, scope validator, DB client, telemetry getters |
| `@lorekit/server` | `packages/mcp-server/` | HTTP server, auth middleware, webhook handler, OTel SDK init |
| `@lorekit/web` | `packages/web/` | Next.js 15 dashboard (login, lore explorer, activity feed, overview) |
| `supabase` | `supabase/` | Migrations, Edge Functions (mcp + health), NX deploy targets |

## Key files

| File | Purpose |
| ---- | ------- |
| `packages/mcp-server/src/instrumentation.ts` | **First import in index.ts** — OTel SDK init, OTLP exporter, forceFlushAll |
| `packages/mcp-core/src/scope.ts` | Canonical scope validation and wildcard expansion |
| `packages/mcp-core/src/telemetry.ts` | Shared tracer/meter getters, `lorekit.tool.duration` histogram |
| `packages/web/src/lib/scope.ts` | Lightweight copy of scopeType for Next.js (no OTel/Supabase server in browser) |
| `supabase/migrations/00001_memories.sql` | Full DB schema with FTS, indexes, RLS policies |
| `supabase/functions/mcp/index.ts` | Self-contained Deno MCP server + GitHub webhook handler |
| `supabase/functions/health/index.ts` | Public health check (no JWT) — DB probe, returns 200/503 |
| `supabase/project.json` | NX targets for all Supabase operations |

## Endpoints

| URL | Auth | Purpose |
| --- | ---- | ------- |
| `https://<ref>.supabase.co/functions/v1/mcp` | Bearer JWT or service-role key | MCP server for agents |
| `https://<ref>.supabase.co/functions/v1/health` | None (public) | Uptime monitoring |
| `https://<your-vercel>.vercel.app` | GitHub OAuth | Web dashboard |

## NX commands

### Dev & CI

```bash
pnpm nx run-many -t typecheck,test,lint --all   # full CI gate (all packages)
pnpm nx typecheck mcp-core                       # fast typecheck
pnpm nx typecheck mcp-server
pnpm nx typecheck web
pnpm nx test mcp-core                            # unit/integration tests (needs supabase start)
pnpm nx test mcp-server
pnpm nx serve mcp-server                         # run Node.js MCP server locally
pnpm nx serve web                                # run Next.js dev server
```

### Supabase — local development

```bash
pnpm nx start supabase      # start local Supabase (Postgres + Auth + Edge Functions)
pnpm nx stop supabase       # stop local Supabase
pnpm nx status supabase     # show local Supabase status + connection strings
pnpm nx fn:dev supabase     # run Edge Functions locally (hot-reload)
pnpm nx db:reset supabase   # reset local DB (applies migrations from scratch)
pnpm nx db:diff supabase    # diff local schema vs remote (linked project)
```

### Supabase — production (requires SUPABASE_PROJECT_REF in .env.local)

```bash
pnpm nx db:push supabase    # typecheck all → apply pending migrations to production
pnpm nx fn:deploy supabase  # typecheck → deploy mcp + health functions
pnpm nx db:types supabase   # generate TypeScript types from remote DB schema
pnpm nx health supabase     # curl the public /health endpoint (quick status check)
```

### Full deploy pipeline

```bash
# Runs: typecheck (all) + test (mcp-core + mcp-server) → db push → fn:deploy (mcp + health)
# Requires: supabase start (for tests) + SUPABASE_PROJECT_REF
pnpm nx deploy supabase
```

### One-liner for first-time setup

```bash
# 1. Link to your Supabase project
supabase link --project-ref $SUPABASE_PROJECT_REF

# 2. Apply migrations + deploy function (with test gate)
pnpm nx deploy supabase

# 3. Web app is deployed automatically by Vercel on git push
```

## Scope format (canonical)

`::` is the ONLY valid separator. Any other separator returns 400.

```
global
project::{name}
repo::{owner}/{repo}
branch::{owner}/{repo}::{branch}
```

## OTel custom attributes

All custom `lorekit.*` spans carry:
- `lorekit.tool.name` — bounded: `memory.write|read|list|delete|search`
- `lorekit.scope` — canonical scope string
- `lorekit.scope.type` — bounded: `global|project|repo|branch`
- `lorekit.key` — lesson key
- `lorekit.result.count` — result set size (list/search)

Metric: `lorekit.tool.duration` histogram (unit: `s`) with `lorekit.tool.name` and `lorekit.scope.type`.

## Dash0 telemetry

Get endpoint + token from:
- Endpoint: https://app.dash0.com/settings/endpoints
- Auth token: https://app.dash0.com/settings/auth-tokens

Env vars required:
```
OTEL_SERVICE_NAME=lorekit
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.us-east-1.aws.dash0.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

## Key decisions

- `::` separator — avoids collision with `/` in repo paths and `:` in branch names
- `AlwaysOn` sampler — sampling deferred to Dash0 pipeline (never SDK-side)
- `instrumentation.ts` first import — OTel must be initialised before any other require
- `pino` for structured logging — `trace_id`/`span_id` injected via `formatters.log`
- Two packages — `mcp-core` is independently testable without the HTTP server
- NX version 22.4.0 — matches `gw-tools` exactly; bump both together
