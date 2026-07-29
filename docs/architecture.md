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
│  Web dashboard (https://lorekit.io)                    │
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
| `@lorekit/core` | `packages/mcp-core/` | Node.js | Scope validator, DB client wrappers, 10 tool handlers, OTel tracer/meter |
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
       │    → returns user_id + permissions (read | write | read+write)
       │    → service-role DB client + explicit user_id filter on every query
       │
       └─ else: validate as Supabase JWT via auth.getUser()
            → user-scoped DB client (RLS enforced automatically)
```

**Key security invariant:** API key auth uses the service-role client (bypasses RLS), so **every read is tenant-scoped in app code** — to the caller's own `user_id` **or** an org they belong to — through the single `applyTenantScope` predicate ([Organizations](#organizations)). A user can never read another user's personal memories, or an org's memories unless they're a member.

---

## Data model

### `memories` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `user_id` | uuid | References `auth.users`. Null for CI/service writes **and for org-owned rows** (but not for personal API-token writes). |
| `org_id` | uuid | FK → `orgs(id)`, nullable. Set for org-owned (shared) lore, null for personal. See [Organizations](#organizations). |
| `created_by` / `updated_by` | uuid | Author attribution for org-owned rows (which keep `user_id` null) — powers "last updated by @handle". |
| `scope` | text | Canonical scope string — see [scope-format.md](./scope-format.md) |
| `key` | text | Lesson identifier |
| `value` | text | Lesson body (markdown, max 64 KB) |
| `tags` | text[] | e.g. `["source::pr-webhook", "skill::aw"]` |
| `source_agent` | text | Which agent wrote this (e.g. `aw-executor`) |
| `trigger` | text | What triggered the write (e.g. `stuck-loop`) |
| `fts` | tsvector | Generated always from `key || value` — powers full-text search |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Auto-updated by trigger |

Uniqueness is partitioned across three mutually-exclusive partial indexes so the
three ownership kinds never collide: org-owned (`org_id, scope, key`), personal
(`user_id, scope, key` where `org_id is null`), and service/CI (`scope, key`
where both are null).

### `api_tokens` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `user_id` | uuid | References `auth.users` |
| `name` | text | Human label (e.g. `aw-executor`) |
| `token_prefix` | text | First 12 chars + `...` for display (e.g. `lk_rw_aBcD1...`) |
| `token_hash` | text | SHA-256 of the full token — never stored in plain text |
| `permissions` | text[] | `["read", "write"]`, `["read"]`, or `["write"]` |
| `last_used_at` | timestamptz | Updated on auth via `EdgeRuntime.waitUntil` (survives isolate teardown; non-blocking) |

### `audit_log` table

Append-only trail of security/data-affecting actions, surfaced at
**Settings → Audit Logs**. See [limits.md](./limits.md#config-source--per-user-overrides)
for the one deliberate app-layer-capture exception.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `user_id` | uuid | References `auth.users`. Null for service-role/CI writes and JWT-authenticated MCP calls (never surfaced to any user — RLS SELECT requires a matching `auth.uid()`) |
| `action` | text | Bounded CHECK — e.g. `api_key.create`, `memory.archive`, `limit.override`, `org.create`, `member.invite`, `scope.bind` (widened by migrations 00023, 00027 as new action types were added) |
| `resource_type` / `resource_id` | text | What was acted on, e.g. `memory` / the memory's id |
| `target` | text | Human-readable label (a key, a repo, a token name) |
| `metadata` | jsonb | Action-specific extra detail (never a raw token or hash) |
| `created_at` | timestamptz | |

RLS: users SELECT only their own rows; a scoped INSERT policy backs the
authenticated dashboard writer; **no update/delete policy** — immutable via
the API surface.

**Reading it — keyset pagination + search.** `listAuditLog` (the dashboard's
Settings → Audit Logs reader) pages the log with **keyset (cursor) pagination**,
not `OFFSET`: rows are ordered `(created_at desc, id desc)` and each page
returns an opaque `nextCursor` (base64url-encoded `{ created_at, id }`,
`packages/web/src/lib/pagination/cursor.ts`) instead of a page number. The
cursor carries no `user_id` — `listAuditLog` always applies its own
`.eq('user_id', …)` regardless of what the cursor says — so a malformed or
forged cursor can at worst mis-page the caller's own rows, never widen
visibility; `decodeCursor` fails closed to `null` (treated as page one) on
any decode error. Callers may combine three optional filters (AND'd): an
action set, a case-insensitive substring on `target`, and an inclusive
`from`/`to` date interval. The pure decision logic (cursor codec, page-size
clamping, the keyset predicate, filter normalization/escaping, date-boundary
math) lives in `packages/web/src/lib/pagination/` — audit-decoupled and unit
tested — with a thin Supabase-boundary shell (`apply.ts`) as the only impure
piece. Migration `00012_audit_log_search.sql` adds the supporting indexes: a
`pg_trgm` GIN trigram index on `target` (so the `ilike` substring search
doesn't degrade to a sequential scan) and a `(user_id, created_at desc, id)`
index covering the keyset seek (00010's `(user_id, created_at desc)` index
lacks the `id` tiebreaker the keyset predicate needs).

### `usage_events` table

Lightweight structured telemetry for plan-sizing analysis, appended on every significant MCP tool call outcome. Rows are stored in **Postgres** (not exported to Dash0 traces) so you can query them directly in SQL without a Dash0 token. See [otel.md](./otel.md#structured-usage-events-usage_events-table) for the schema, retention policy, and example queries.

Key columns: `user_id`, `org_id`, `plan_name`, `tool_name`, `scope_type`, `auth_type`, `outcome` (`ok` | `cap_exceeded` | `rate_limited` | `permission_denied` | `error`), `duration_ms`. Rows are retained 90 days and purged weekly by `lorekit_purge_old_usage_events()`.

---

### Organizations

Organizations let a team share one authoritative set of memories (see the
user/operator guide, [org-sharing.md](./org-sharing.md)). Two tables back it:
`orgs` (name, slug, and a nullable `deleted_at` soft-delete marker) and
`org_members` (a `(org, user)` row with a `role` of `owner`/`admin`/`member`/`viewer`).

**One tenant-visibility predicate.** Which orgs a user can see lives in exactly
one place: the `SECURITY DEFINER` function `lorekit_member_org_ids(user)`. Both
the `memories` read RLS policies and the edge API-key read path
(`applyTenantScope`, mirrored between `packages/mcp-core` and the edge function)
consume it, so widening visibility to org membership was a single change and
can't drift. This is why the earlier "every query filters `user_id`" invariant
is now "reads are scoped to `user_id` **OR** an org the caller belongs to" — the
`org_id in (lorekit_member_org_ids(auth.uid()))` branch is that predicate.

**Membership writes go through RPCs, not RLS.** `orgs`/`org_members`/`org_invites`
carry no insert/update/delete RLS policy; every state transition (create, invite,
accept/decline, role change, remove, leave, delete) is a `SECURITY DEFINER` RPC
that resolves the actor as `auth.uid()` and gates on `lorekit_org_can`. This
avoids the owner-bootstrap footgun (a self-insert-as-owner policy would let
anyone seize any org) and keeps invite-accept atomic.

**Deletion is a soft-delete.** `lorekit_org_delete` stamps `orgs.deleted_at`
rather than removing the row; `lorekit_member_org_ids` excludes soft-deleted
orgs, so the org's lore vanishes from every read at once while staying
recoverable. A separate owner-only `lorekit_org_purge` does the real cascading
delete. See [org-sharing.md](./org-sharing.md#deleting-an-organization-and-getting-it-back).

Org writes are authorization-derived: `memory_write` accepts an org slug but
requires `lorekit_org_can(writer, org, 'write')` inside the RPC — the org is
never trusted from the caller.

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
