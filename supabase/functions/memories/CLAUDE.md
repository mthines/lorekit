# memories — REST memory CRUD

Handles all memory operations via HTTP. Auth is managed by the shared `resolveRestAuth` utility (service key, lk_ API token, or Supabase JWT).

## URL patterns

| Method | Path | Handler | Permission |
|--------|------|---------|------------|
| GET | / | list.ts | read |
| POST | / | create.ts | write |
| DELETE | / | remove.ts | write |
| POST | /search | search.ts | read |
| POST | /restore | restore.ts | write |
| POST | /purge | purge.ts | write |
| POST | /purge-expired | purge.ts | write |
| GET | /scopes | scopes.ts | read |
| GET | /tags | tags.ts | read |
| GET | /activity | activity.ts | read |
| GET | /usage | usage.ts | read |
| GET | /:id | get.ts | read |
| PATCH | /:id | update.ts | write |
| DELETE | /:id | remove.ts | write |
| POST | /:id/restore | restore.ts | write |

**Route order is load-bearing.** `matchPath` (`_shared/api/router.ts`) matches on segment
count and returns *every* path match, then picks the first whose method matches — so
`/search`, `/restore`, `/purge`, `/purge-expired`, `/scopes`, `/tags` and `/activity` all
collide with `/:id`.
The literal routes are registered before the `/:id` routes in `index.ts` so a future
`POST /:id` cannot silently swallow them.

## Archiving, restoring and deleting

| Intent | Request |
|--------|---------|
| List archived lore | `GET /?archived=true` — **this is the `memory.list-archived` equivalent**; there is no separate route. `?archived=false` (the default) lists only live, non-expired rows. |
| Archive (soft-delete) | `DELETE /:id` or `DELETE /?scope=…&key=…` → `204`. Stamps `archived_at`; the row stays recoverable. |
| Hard-delete | Add `?force=true` to either DELETE form → `204`. Performs a real row delete, is **irreversible**, and (unlike the archive path) also applies to already-archived rows. Mirrors the MCP `memory.delete` tool's `force` branch, down to the `lorekit.delete.force` span attribute. `force` accepts only the literal strings `true`/`false`; anything else is a `400`. |
| Archive/hard-delete **org-owned** lore | Add `?org=<slug>` to the `scope`+`key` DELETE form → `204`. See below. |

### `?org=<slug>` — the role-gated delete

`DELETE /?scope=…&key=…&org=<slug>` (optionally `&force=true`) targets lore owned by an
organization instead of the caller. It does **not** run the direct
`.delete()` / `.update()` the personal branch runs; it calls the `memory_delete` SECURITY
DEFINER RPC (`supabase/migrations/00020_memory_delete_org.sql`) with exactly the argument
set the MCP `memory.delete` tool uses — `p_user_id`, `p_org_slug`, `p_scope`, `p_key`,
`p_force`.

That is not a stylistic choice. The api_key tier reaches Postgres over a **service-role
client that bypasses RLS**, so a raw org-targeted query would have no role gate at all. The
gate (`lorekit_org_can` — `archive` for a soft-delete, `hard_delete` for `?force=true`)
lives inside the RPC and nowhere else.

Rules:

- **`org` requires `scope` + `key`.** The RPC is keyed on the natural key and has no id
  parameter, so `DELETE /:id?org=…` is a **400**, never a silent fall-through — ignoring
  `org` there would delete the caller's *personal* row while they believed they were
  deleting the org's.
- **A role denial is `LK002` → 403.** It is translated at the call site with
  `translateDbError` rather than left to bubble, so the mapping cannot be lost to a generic
  500 path.
- **An unresolvable slug raises `unknown_org` (P0001)** inside the RPC — same as
  `memory_write`.
- **The audit action comes from what the RPC reports it did** (`deleted` vs `archived`), not
  from the requested `force`, and metadata carries `org`. This mirrors `toolDelete` exactly.
- **`POST /restore` has no `org` form**, deliberately: the MCP `toolRestore` has no org
  branch either (it is a plain `.eq('user_id', …)` update). Restoring org-owned lore is an
  open gap on **both** surfaces; adding it to only one would break parity in the other
  direction.
| Restore | `POST /:id/restore`, or `POST /restore` with `{ "scope": …, "key": … }` → `200 { "restored": true }`. Only matches archived rows, so restoring a live row (or a nonexistent one) is a `404`. |
| Purge archived | `POST /purge` with an optional `{ "retention_days": 1–365 }` (default 30) → `200 { "purged": <n> }`. Body may be omitted entirely. |
| Purge expired | `POST /purge-expired` (no body) → `200 { "purged": <n> }`. |

## Filtering `GET /` — `?q=` and `?tags=`

`q` is a **case-insensitive substring** match over `key` OR `value` (the as-you-type filter),
deliberately not the stemmed full-text `q` of `POST /search`. Every character in it is DATA:

- LIKE metacharacters (`%`, `_`, `\`) are escaped by `likeNeedle`, so searching `100%` finds
  the text `100%` instead of matching every row.
- PostgREST-reserved characters (`,` `.` `:` `()`) are carried by **double-quoting** the
  finished pattern (`ilikeClause` → `key.ilike."%a,b(c)%"`), which is the only mechanism the
  URL grammar defines for them. Percent-encoding does not work here and is not a matter of
  taste: the clause reaches the wire through postgrest-js `.or()` →
  `URLSearchParams.append`, which re-encodes the `%`, so a hand-written `%2C` arrives as the
  literal four-character text `%2C`. Both halves live in `@lorekit/schemas`'s `filter.ts` and
  are shared with the `filter` tree of `POST /search`, so the two search paths cannot drift.

`tags` is a comma-separated label list; `tags_mode=any` (default) is overlap (`&&`) and
`tags_mode=all` is containment (`@>`). The list is quoted into a Postgres array literal by
`pgArrayLiteral` — postgrest-js would otherwise `join(',')` an array and mis-parse a label
containing a comma, brace, quote or backslash, all of which `memories.tags` permits. A label
containing a comma is unreachable over this parameter by construction (the wire format splits
on commas); `POST /search` is the way to express one — either its `tags` array, whose JSON
body carries the label verbatim and which goes through the same `pgArrayLiteral`, or its
`filter` tree.

Both filters are covered end-to-end in
`packages/mcp-server/src/memories-api.integration.spec.ts` → "list filters", against a live
stack. That is deliberate: the Storybook MSW handler reimplements both, so it can only ever
confirm itself — `handleList` threw on every `?tags=` request for a whole commit while that
suite was green.

## `created_at` on `POST /`

`created_at` is an **optional creation-date override** for the `lorekit migrate` backdating
case, and it is honoured (it used to be silently dropped — `p_created_at` was hard-coded to
`null`). The value is validated by `_shared/created-at.ts`'s `parseCreatedAt`, the very same
module the MCP `memory.write` tool uses: parseable date-time, normalised to ISO, and **rejected
if it is in the future** beyond a 60s clock-skew allowance. An invalid value is a `400` naming
the problem, never a silent drop and never a 500. Omitting the field leaves the DB's `now()`
default in place.

`ttl_minutes` / `ttl_seconds` remain **MCP-only**; REST accepts `ttl_days` only.

Both purge endpoints are user-scoped: they call RPCs keyed on `p_user_id`, so a
**service-role** token — which resolves no user — gets a `403`, not a `400`. The request is
well-formed; it is the credential that cannot name a purge target. Both are also
rate-limited on the same per-user window as `POST /` (a `429` carries `Retry-After`).

## `GET /scopes`

Returns every distinct scope the caller can see with its count of active (non-archived,
non-expired) memories, sorted by scope ascending:

```json
{
  "scopes": [
    { "scope": "global", "count": 12, "last_activity": "2026-07-30T09:12:00.000Z" },
    { "scope": "repo::acme/app", "count": 3, "last_activity": "2026-07-28T17:04:00.000Z" }
  ]
}
```

The aggregation runs in Postgres (`lorekit_memory_scopes`, migration 00039), **not** as a
`select('scope')` plus a client-side `Set`. The client-side form is silently wrong past
PostgREST's default row cap: the response is truncated with no error, so whole scopes go
missing. Visibility inside the RPC composes `lorekit_member_org_ids` exactly as the
`memories` RLS read policies do, so personal and org-shared scopes both appear.

`last_activity` (migration 00049) is `max(created_at)` over exactly the counted rows, so a
caller can render per-scope freshness without listing rows to reduce them — the row-cap trap
this endpoint exists to avoid.

## `GET /tags`

The label catalog: every distinct `memories.tags` value the caller can see with how many
memories carry it, ordered count desc then label asc.

```json
{ "tags": [{ "tag": "perf", "count": 9 }, { "tag": "auth", "count": 4 }] }
```

`?archived=true` returns the archived partition instead, exactly as it does on `GET /`. The
catalog must describe the population it will be used to filter: active and archived are
different populations, so a catalog pinned to one has the wrong counts — and hides
archive-only labels — in the other.

Same rationale as `/scopes` for aggregating in Postgres (`lorekit_memory_tags`, migration
00050), and the same tenant predicate.

## `GET /activity`

Memories created per UTC hour or day per scope, over a half-open `[since, until)` window:

```json
{
  "bucket": "day",
  "since": "2026-01-01T00:00:00.000Z",
  "until": "2026-07-19T00:00:00.000Z",
  "buckets": [{ "bucket": "2026-07-18T00:00:00.000Z", "scope": "global", "count": 4 }]
}
```

| Param | Default | Meaning |
|-------|---------|---------|
| `bucket` | `day` | `hour` or `day` granularity. |
| `since` | `until` − 200 days | Inclusive lower bound on `created_at`. |
| `until` | now | **Exclusive** upper bound. |

`date_trunc` anchors each bucket at the START of the UTC hour/day (`lorekit_memory_activity`,
migration 00051), which is where a JS client's own `Math.floor(t / HOUR)` / `Date.UTC(y,m,d)`
boundaries fall — so a client re-tallying these cells gets the same numbers it would have
got from raw rows. The response is sparse: only buckets with activity come back, so its
size is bounded by distinct active (hour, scope) pairs rather than by memory count.

The window is bounded by default deliberately: an unbounded aggregate over `memories` grows
with account age and no caller wants "all time".

## `GET /usage`

Aggregate usage statistics for the caller's **own** activity, read back from
`usage_events` (migration 00034) — "how many reads/writes today, per scope-type,
per outcome" so a human or agent can judge whether LoreKit is helping.

```json
{
  "range": { "since": "2026-07-31T00:00:00.000Z", "until": null },
  "correlation_id": null,
  "summary": { "total_events": 812, "reads": 640, "writes": 120, "other": 52,
               "records_read": 5120, "expired": 6,
               "by_outcome": { "ok": 780, "cap_exceeded": 2, "error": 30 } },
  "by_tool": [{ "tool_name": "memory.list", "outcome": "ok", "scope_type": "repo",
                "event_count": 600, "record_count": 5000, "total_duration_ms": 42000 }],
  "by_scope_type": [{ "scope_type": "repo", "event_count": 610 }]
}
```

**Call counts vs record counts.** `event_count` / `reads` / `writes` count tool
CALLS; `record_count` / `records_read` count the RECORDS those calls touched, so
`records_read` is the literal "you read N memories today" figure, not the number
of read calls. `expired` is "N lessons expired" — `sum(record_count)` over the
`memory.expired` bucket that `purge_expired_memories` emits (migration 00045).

Query params (all optional): `period` (`24h`/`7d`/`30d`/`90d`/`all`), or an
explicit ISO `since`/`until` (`since` overrides `period`; the window is half-open
`[since, until)`); `correlation_id` to restrict to one PR / session / job.
Omitting everything is all-time, unfiltered.

The grouping runs in Postgres (`lorekit_usage_stats`, migrations 00043 + 00044),
**not** as a `select` + client-side reduce — the client-side form is silently
truncated past PostgREST's row cap, exactly like `GET /scopes`. Visibility is
self-only (the RPC filters `user_id = caller`, with the same `service_role` +
NULL escape hatch `lorekit_memory_scopes` uses); there is no
`applyRestTenantScope` call because there is no query to scope. `summary` and
`by_scope_type` are computed by the pure `summarizeUsageRows` /
`rollupByScopeType` (`_shared/usage-stats.ts`, mirror of
`packages/mcp-core/src/usage-stats.ts`) from the SAME rows returned as `by_tool`,
so the headline totals can never disagree with the detail. Window + correlation
validation are the pure `parseUsageWindow` / `parseCorrelationId` in the same
module; an inverted/malformed window is a `400`, and a **malformed
`correlation_id` query param is a `400` too** — a read fails loud rather than
silently widening to account-wide totals dressed up as one PR's. This is the one
deliberate asymmetry with the write side: the `X-LoreKit-Correlation-Id` *header*
degrades a bad value to null (a benign "don't group it"), because on a write the
caller didn't ask to filter anything; on a read they did, and returning the wrong
scope of data silently is the trap.

Like `GET /scopes`, there is **no MCP tool** for this — an aggregate read has no
scope-keyed MCP equivalent. Its `usage_events.tool_name` is `memory.usage`
(`rest-tool-name.ts`).

### Usage write contract (how the numbers get populated)

Two headers, both optional and read once in the router / MCP handler — never a
per-handler concern:

- **`X-LoreKit-Correlation-Id`** (request) — an opaque grouping key (a PR ref
  like `mthines/lorekit#123`, a branch, a session id, a CI job id). Both the REST
  router (`CORRELATION_HEADER`) and the MCP handler read it, validate it through
  `parseCorrelationId` (≤200 chars, `[A-Za-z0-9_-./:#@]`; a bad value degrades to
  null, never a 4xx), and stamp it on every `usage_events` row the request
  writes. `GET /memories/usage?correlation_id=…` then answers "usage for this
  PR". **Client contract:** any client can set it. The `lorekit` CLI emits it
  automatically from the `LOREKIT_CORRELATION_ID` env var (`restFetch`,
  `normalizeCorrelationId`) — a hook or CI job that exports that var (to the PR
  ref / session id) tags every subsequent CLI call. Wiring a specific hook to
  export it is the remaining client-side step.
- **`X-LoreKit-Result-Count`** (response) — the collection read handlers
  (`list`/`search`/`get`) set it to the number of records they returned; the
  router reads it once (`RESULT_COUNT_HEADER`) and records it as the event's
  `result_count`. Fail-safe: an absent/garbage value records no count, never
  breaks the request. The MCP handler computes the same figure from the tool
  result via `countRecords`.

## Audit events

Every mutating handler writes to `audit_log` through **the one shared edge writer**,
`_shared/audit.ts` — the same `recordAudit` the MCP tools call (it was promoted out of
`mcp/audit.ts`; there is deliberately no second writer under `_shared/api/`).

| Handler | Action | Notes |
|---------|--------|-------|
| `create.ts` | `memory.create` / `memory.update` | Discriminated by the `inserted` flag `memory_write` returns (migration 00011), exactly as `toolWrite` does. Carries `resourceId`. |
| `update.ts` | `memory.update` | Only when the PATCH matched a row (a 404 audits nothing). |
| `remove.ts` | `memory.delete` (`?force=true`) / `memory.archive` | One event per affected row; `metadata.force` records which branch ran. The `?org=` form audits what the `memory_delete` RPC reported it did, not what was asked for. |
| `restore.ts` | `memory.restore` | Only when a row was actually un-archived. |
| `purge.ts` | `memory.delete` | One **summary** event per run (`target: "<n> archived memories"` / `"<n> expired memories"`), only when `purged > 0` — the RPCs return a count, not rows. |

Three invariants, all mirrored from the MCP side:

- **After, and only if it changed something.** The audit call comes after the primary
  operation committed, guarded the way the MCP tools guard on `if (archived)` / `if (deleted)` /
  `if (purged > 0)`.
- **It can never fail the request.** `recordAudit` does not throw; a failed insert is logged
  and swallowed.
- **The actor is auth-type-sensitive** (`auditUserId` in `_shared/api/auth.ts`, re-exported from
  the pure `_shared/rest-audit-actor.ts`): the resolved user for BOTH `api_key` and user-JWT
  callers, `null` ONLY for service-role. It previously returned `null` for JWT callers too, and
  that was a bug: the JWT client is RLS-scoped, `audit_log`'s INSERT policy is
  `with check (user_id = auth.uid())`, and `auth.uid()` is that caller's id — so passing the id
  is what makes the insert legal, and passing `null` is what made it fail the policy and be
  swallowed. Every JWT-authenticated REST mutation lost its audit row until this was fixed.
  Service-role stays `null`: no human actor, and that client bypasses RLS anyway.
  The MCP surface (`mcp/auth.ts`'s `getUserId`) still returns `null` for JWT and still loses
  those rows — that is the remaining gap, and MCP is the side that should converge on this rule.

## `POST /search` body

| Field | Type | Notes |
|-------|------|-------|
| `q` | string | Full-text search over `fts` (websearch syntax, English config). |
| `scopes` | string[] | Exact-match `scope IN (...)`. |
| `tags` | string[] | Array overlap. |
| `filter` | FilterGroup | OR+AND tree — see below. |
| `limit` | 1–100 | Defaults to 50. |
| `cursor` | string | Keyset cursor from a previous page. |

At least one of `q`, `scopes` or `filter` is required; a body with none is a 400.

### The `filter` tree

A `FilterGroup` is recursively `{ and: FilterGroup[] } | { or: FilterGroup[] } | Condition`,
where a `Condition` is `{ field, op, value? }`. Operators: `is`, `is_not`, `contains`,
`does_not_contain`, `starts_with`, `ends_with`, `is_set`, `is_not_set`.

Filterable fields are whitelisted — `scope`, `key`, `value`, `tags`, `source_agent`,
`trigger`. A condition naming any other column is **dropped silently** (it is not an
error) so a caller can never filter on `user_id`/`org_id` and subvert tenant scoping.

```jsonc
{
  "filter": {
    "and": [
      { "field": "scope", "op": "is", "value": "global" },
      { "or": [
        { "field": "key",  "op": "contains", "value": "auth" },
        { "field": "tags", "op": "contains", "value": "pr-webhook" }
      ]}
    ]
  },
  "limit": 50
}
```

`filter` composes with `q`, `scopes` and `tags` — all are ANDed together. The translation
to PostgREST lives in `@lorekit/schemas/filter` (`serializeFilterGroup`), applied by
`_shared/api/filter.ts`; add operators or filterable columns in the schemas package.

## Auth rules

- API tokens (`lk_rw_*`) need `write` permission for POST/PATCH/DELETE.
- API tokens (`lk_ro_*`) work for GET/search.
- Service role key bypasses all tenant filters.
- JWT users see only their own memories plus org-shared memories.

## Adding a handler

1. Create `handlers/{name}.ts` exporting `async function handle{Name}(req, auth, db, span, params, cors)`.
2. Import in `index.ts` and add a route entry to the `createRouter` call.
3. Use `validateBody` / `validateQuery` / `validateUuid` from `_shared/api/validate.ts`.
4. Always create a child span: `span.child('lorekit.memories.{operation}')`.
5. Translate DB errors with `translateDbError` before re-throwing.
6. If it mutates, honour dry-run: after all validation/auth/ownership checks and BEFORE the first
   write, `if (isDryRunHeader(req.headers.get(DRY_RUN_HEADER))) return dryRun(cors);`
   (`_shared/dry-run.ts` + `_shared/api/respond.ts`). `dry-run-coverage.spec.ts` fails the build
   for any mutating route that skips it.
