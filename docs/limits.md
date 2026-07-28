# Limits & Rate Limiting

LoreKit ships two abuse guardrails so any single account can't exhaust storage
or saturate the MCP endpoint: a per-user cap on stored (active) memories, and
a per-user request rate limit. Both are plan-driven and per-user overridable —
laying the groundwork for a future paid tier without any billing logic built now.

## Plans

Plans live in the `plans` table (`supabase/migrations/00032_plans.sql`). The
only plan right now is **free**:

| Plan | Max memories | Requests/min |
|------|-------------|-------------|
| free | **5,000**   | 120         |

A user's plan is tracked in `user_plans` (one row per user; absent = free). A
`user_limits` row overrides any plan ceiling — useful for per-user capacity
adjustments without plan promotion.

## Memory cap

Each free-plan user can store up to **5,000 active memories**. "Active" means
not archived (`archived_at IS NULL`) — archiving a memory frees cap headroom
immediately.

The cap is enforced **at the database level** by a `BEFORE INSERT` trigger
(`enforce_memory_cap()`, see `supabase/migrations/00004_limits.sql` and
`00032_plans.sql`), not only in application code. This makes it authoritative
regardless of which client inserts the row (the Deno edge function, the
Node.js `mcp-server`, or any future direct DB access).

- Re-writing an existing `(scope, key)` (an upsert `UPDATE`) never counts
  against the cap — only genuinely **new** rows go through the trigger.
- Service-role / CI writes (`user_id IS NULL`) are exempt.

When a write would exceed the cap, the DB raises a custom error (SQLSTATE
`LK001`), which the app layer translates into an actionable MCP error
(`memory_cap`) telling the caller their limit and plan, and how to raise it:

> "You've reached the free-plan limit of 5000 stored memories. Archive or
> delete unused memories, or upgrade your plan — see
> https://lorekit.io (or contact support) to increase it."

## Rate limiting

Each user is limited to **120 requests per minute** by default, across every
MCP method (not just writes — read-heavy sieges are throttled too).

Rate limiting is a **Postgres-backed fixed-window counter**
(`lorekit_check_rate_limit()` RPC) — not in-memory — because edge function
isolates are stateless and short-lived; an in-memory counter would only ever
see one instance's traffic. The RPC atomically increments a tiny
`(user_id, window_start)` counter row and returns whether the request is
allowed plus how long until the next window opens.

The transport layer (the Deno edge function's `index.ts`, and the Node
`mcp-server`'s `handleMcpRequest`) calls this check immediately after auth
resolves and before dispatching the request. A blocked request receives:

```
HTTP 429 Too Many Requests
Retry-After: <seconds>
```

with a JSON-RPC body describing the limit and how to raise it. Service-role
(CI/internal) requests are exempt.

**Fail-open on RPC error:** if the rate-limit check itself errors (a DB
blip), the request is allowed through rather than returning a 500 — the
memory cap still protects storage during an outage.

**Counter cleanup:** every request writes a `(user_id, window_start)` row, but
only the current window is ever read. `lorekit_purge_rate_limit_counters()`
hard-deletes windows older than an hour and is scheduled every 15 minutes via
pg_cron (when the extension is available), so the counter table and its index
stay small. Without pg_cron, drive the function from an external scheduler.

## Config source & per-user overrides

Both guardrails read their limits through a single function,
`lorekit_get_limit(user_id, key)`, which resolves:

```
user_limits override  →  plan default (user_plans → plans)  →  lorekit_default_limit('free')
```

- `plans` table — the canonical per-plan limits (seeded by `00032_plans.sql`).
  Adding a new paid tier is a single INSERT. No numeric limit is hardcoded in
  app code.
- `user_plans` — tracks which plan each user is on (absent = free).
- `user_limits` — a per-user override table. An absent row (or a `null`
  column) means the user is on their plan's default.

**Raising a user's limit today** is a one-row upsert:

```sql
insert into user_limits (user_id, max_memories, requests_per_minute)
values ('<user-uuid>', 5000, 600)
on conflict (user_id) do update
  set max_memories = excluded.max_memories,
      requests_per_minute = excluded.requests_per_minute,
      updated_at = now();
```

There is no admin UI for this yet — it's deliberately deferred until a paid
tier is built. The schema already supports it: a future billing integration
only needs to write to `user_limits`.

**Audit trail exception:** every other sensitive action in LoreKit (API-key
create/revoke, webhook-secret create/rotate, memory create/update/archive/
restore/delete) is recorded in `audit_log` by an explicit app-layer call —
see `packages/mcp-core/src/audit.ts` and CLAUDE.md's "Key decisions". Because
no app-layer code path writes `user_limits` today, that one table is audited
by a DB trigger instead (`audit_user_limits()`, in
`supabase/migrations/00010_audit_log.sql`), which fires on every insert,
update, or delete and records a `limit.override` row. This is a deliberate,
narrowly-scoped exception to the app-layer capture rule — if an admin UI or
server action for `user_limits` is ever built, instrument that call site
directly rather than relying solely on the trigger.

## Where the code lives

| Concern | Deno edge function (production) | Node.js (`mcp-server`) | Shared logic |
|---|---|---|---|
| Config + enforcement | — (DB-side) | — (DB-side) | `supabase/migrations/00004_limits.sql` |
| Cap error translation | `supabase/functions/mcp/limits.ts` → wired in `tools.ts` (`toolWrite`) | `packages/mcp-core/src/limits.ts` → wired in `tools/write.ts` | `LimitError`, `translateCapError` |
| Rate-limit check + 429 | `supabase/functions/mcp/index.ts` (post-`resolveAuth`) | `packages/mcp-server/src/server.ts` (`handleMcpRequest`) | `checkRateLimit` |
| MCP error mapping | `supabase/functions/mcp/mcp-handler.ts` (distinct JSON-RPC code) | `server.ts` `memory.write` tool handler (`isError: true`) | `LimitError.code` |

The Deno module is a **self-contained mirror** of `packages/mcp-core/src/limits.ts`
(same convention as `_shared/scope.ts` mirroring `mcp-core`'s scope validator)
— the edge function has no cross-package imports. Keep the two in sync when
either changes.
