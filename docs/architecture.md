# Architecture

## What LoreKit is

LoreKit is a shared memory layer for AI coding agents. Agents write lessons they learn (called *lore*) to a central Supabase Postgres database via the MCP protocol. Any agent on any machine — or in CI — can read those lessons back.

**The core problem it solves:**

| Without LoreKit | With LoreKit |
|-----------------|--------------|
| Lessons live in `.claude/` files, lost after CI | Lessons survive every run, every machine |
| One developer's learnings stay local | Team shares the same accumulated knowledge |
| PR review comments need manual copy-paste | GitHub webhook creates lessons automatically |
| Agents can't see what they've learned before | Agents query scoped memory before planning |

---

## System overview

```
┌─────────────────── Clients ────────────────────────────┐
│  AI agent (persistent-memory skill)                    │
│  CI job (GitHub Actions, service-role token)           │
│  GitHub webhook (PR review comment → lesson)          │
│  Web dashboard (https://lorekit-io.vercel.app)         │
└───────────────────────────────────────────────────────-┘
                          │
                    HTTPS + Bearer
                          │
┌─────────────── Supabase Edge Functions ────────────────┐
│  /functions/v1/mcp          MCP JSON-RPC server        │
│  /functions/v1/health       Public health check        │
└────────────────────────────────────────────────────────┘
                          │
                    Postgres + RLS
                          │
┌─────────────────── Supabase ───────────────────────────┐
│  memories table     Lessons storage (FTS + RLS)        │
│  api_tokens table   Hashed token registry              │
│  Auth               GitHub OAuth (user sessions)       │
└────────────────────────────────────────────────────────┘
                          │
                    OTLP HTTP
                          │
┌───────────────────── Dash0 ────────────────────────────┐
│  Traces  Metrics  Logs   Observability for every call  │
└────────────────────────────────────────────────────────┘
```

---

## Monorepo packages

| Package | Path | Runtime | Role |
|---------|------|---------|------|
| `@lorekit/core` | `packages/mcp-core/` | Node.js | Scope validator, DB client wrappers, 5 tool handlers, OTel tracer/meter |
| `@lorekit/server` | `packages/mcp-server/` | Node.js | HTTP entry point, auth middleware, GitHub webhook, OTel SDK init (for Fly.io deployment) |
| `@lorekit/web` | `packages/web/` | Vercel / Next.js 15 | Dashboard: login, lore explorer, activity feed, overview + onboarding |
| `supabase` | `supabase/` | Deno (Edge Functions) | Self-contained MCP server + health check + migrations |

> The Edge Functions (`supabase/functions/mcp/`, `supabase/functions/health/`) are the **production MCP server**. `packages/mcp-server/` is the Node.js variant for deployments where full OTel instrumentation matters (Fly.io).

---

## Authentication tiers (MCP server)

Three tiers, evaluated in order on every request:

```
Authorization: Bearer <token>
       │
       ├─ token === SUPABASE_SERVICE_ROLE_KEY?
       │    → service auth (full access, bypasses RLS — CI use only)
       │
       ├─ token starts with "lk_"?
       │    → look up SHA-256(token) in api_tokens table
       │    → returns user_id + permissions (read | read+write)
       │    → service-role DB client + explicit user_id filter on every query
       │
       └─ else: validate as Supabase JWT via auth.getUser()
            → user-scoped DB client (RLS enforced automatically)
```

**Key security invariant:** API key auth uses the service-role client (bypasses RLS), but **every query** includes `.eq('user_id', userId)` so users cannot access each other's memories.

---

## Data model

### `memories` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `user_id` | uuid | References `auth.users`. Null for CI/service writes (but not for API token writes). |
| `scope` | text | Canonical scope string — see [scope-format.md](./scope-format.md) |
| `key` | text | Lesson identifier |
| `value` | text | Lesson body (markdown, max 64 KB) |
| `tags` | text[] | e.g. `["source::pr-webhook", "skill::aw"]` |
| `source_agent` | text | Which agent wrote this (e.g. `aw-executor`) |
| `trigger` | text | What triggered the write (e.g. `stuck-loop`) |
| `fts` | tsvector | Generated always from `key || value` — powers full-text search |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Auto-updated by trigger |

Unique constraint: `(user_id, scope, key)`.

### `api_tokens` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `user_id` | uuid | References `auth.users` |
| `name` | text | Human label (e.g. `aw-executor`) |
| `token_prefix` | text | First 12 chars + `...` for display (e.g. `lk_rw_aBcD1...`) |
| `token_hash` | text | SHA-256 of the full token — never stored in plain text |
| `permissions` | text[] | `["read", "write"]` or `["read"]` |
| `last_used_at` | timestamptz | Updated fire-and-forget on auth |

---

## Request lifecycle (MCP tool call)

```
1. Agent sends POST /functions/v1/mcp
   Authorization: Bearer lk_rw_xxx...
   Body: {"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory.write",...}}

2. traceRequest() opens a root span, extracts incoming traceparent

3. resolveAuth() looks up SHA-256(token) in api_tokens
   → returns { type: 'api_key', userId, permissions }

4. handleMcp() dispatches to toolWrite()
   → creates child span "lorekit.memory.write"
   → DB upsert with user_id filter

5. Span ends, ExportBatch.flush() fires OTLP/JSON to Dash0 via EdgeRuntime.waitUntil()

6. Response returned to agent
```

---

## Observability

See [otel.md](./otel.md) for the full setup. Every layer emits telemetry to Dash0:

| Signal source | What's emitted |
|---------------|----------------|
| Edge Function (Deno) | `lorekit.memory.*` spans, `lorekit.webhook.github` spans, DB child spans named by SQL statement |
| Next.js server | HTTP server spans via `@vercel/otel` |
| Browser (RUM) | Page loads, navigation, fetch traces, errors via `@dash0/sdk-web` |

All signals carry `service.namespace=lorekit` and `deployment.environment.name` (`production` / `preview` / `local`).
