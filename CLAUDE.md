# LoreKit — Agent Context

## What this project is

NX monorepo containing a Supabase-backed MCP server for shared, persistent agent memory. Agents read and write lessons via standard MCP tool calls; memories are stored in Postgres with row-level security.

## Package map

| Package | Path | Role |
| ------- | ---- | ---- |
| `@lorekit/core` | `packages/mcp-core/` | Tool handlers, scope validator, DB client, telemetry getters |
| `@lorekit/server` | `packages/mcp-server/` | HTTP server, auth middleware, webhook handler, OTel SDK init |

## Key files

| File | Purpose |
| ---- | ------- |
| `packages/mcp-server/src/instrumentation.ts` | **First import in index.ts** — OTel SDK init, OTLP exporter, forceFlushAll |
| `packages/mcp-core/src/scope.ts` | Canonical scope validation and wildcard expansion |
| `packages/mcp-core/src/telemetry.ts` | Shared tracer/meter getters, `lorekit.tool.duration` histogram |
| `supabase/migrations/00001_memories.sql` | Full DB schema with FTS, indexes, RLS policies |

## NX commands

```bash
pnpm nx run-many -t typecheck,test,lint --all   # full CI gate
pnpm nx typecheck mcp-core                       # fast type check
pnpm nx test mcp-server                          # server tests
pnpm nx serve mcp-server                         # dev server with watch
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
