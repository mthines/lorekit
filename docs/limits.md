# Limits & Rate Limiting

LoreKit ships two abuse guardrails so any single account can't exhaust storage
or saturate the MCP endpoint: a per-user cap on stored (active) memories, and
a per-user request rate limit. Both are free-tier defaults, config-driven,
and per-user overridable — laying the groundwork for a future paid tier
without any billing logic built now.

## Memory cap

Each user can store up to **1000 active memories** by default. "Active" means
not archived (`archived_at IS NULL`) — archiving a memory frees cap headroom
immediately.

The cap is enforced **at the database level** by a `BEFORE INSERT` trigger
(`enforce_memory_cap()`, see `supabase/migrations/00004_limits.sql`), not only
in application code. This makes it authoritative regardless of which client
inserts the row (the Deno edge function, the Node.js `mcp-server`, or any
future direct DB access).

- Re-writing an existing `(scope, key)` (an upsert `UPDATE`) never counts
  against the cap — only genuinely **new** rows go through the trigger.
- Service-role / CI writes (`user_id IS NULL`) are exempt.

When a write would exceed the cap, the DB raises a custom error (SQLSTATE
`LK001`), which the app layer translates into an actionable MCP error
(`memory_cap`) telling the caller their limit and how to raise it:

> "You've reached the free-tier limit of 1000 stored memories. Archive or
> delete unused memories, or raise your limit — see
> https://lorekit-io.vercel.app (or contact support) to increase it."

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
COALESCE(user_limits.<key>, lorekit_default_limit(key))
```

- `lorekit_default_limit(key)` — the single source of free-tier defaults
  (`max_memories` → 1000, `requests_per_minute` → 120). No numeric limit is
  hardcoded anywhere else in the app.
- `user_limits` — a per-user override table. An absent row (or a `null`
  column) means the user is on the free-tier default.

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
