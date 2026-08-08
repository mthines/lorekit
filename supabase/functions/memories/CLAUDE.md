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
| GET | /facets | facets.ts | read |
| GET | /activity | activity.ts | read |
| GET | /read-activity | read-activity.ts | read |
| GET | /usage | usage.ts | read |
| GET | /:id | get.ts | read |
| PATCH | /:id | update.ts | write |
| DELETE | /:id | remove.ts | write |
| POST | /:id/restore | restore.ts | write |

**Route order is load-bearing.** `matchPath` (`_shared/api/router.ts`) matches on segment
count and returns *every* path match, then picks the first whose method matches — so
`/search`, `/restore`, `/purge`, `/purge-expired`, `/scopes`, `/tags`, `/facets`, `/activity`
and `/read-activity` all collide with `/:id`.
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
on commas); `POST /search`'s `tags` array is the way to express one — its JSON body carries
the label verbatim and it goes through the same `pgArrayLiteral`. `SearchMemoriesBodySchema`
requires at least one of `q`, `scopes` or `filter` (`packages/schemas/src/memory.ts:265`) and
the `tags` array is none of the three, so a `tags`-only body is a 400 `Validation failed` —
pair it with a `q` or a `scopes` list.

**The `filter` tree is not a second route to a `tags` predicate.** `serializeFilterGroup` has
no per-column type dispatch (`packages/schemas/src/filter.ts:136-154`), so a condition naming
`tags` serialises as if the column were `text`: `tags.ilike."%x%"` for the pattern operators
(asserted verbatim at `packages/schemas/src/filter.spec.ts:75`) and `tags.eq."x"` for `is`.
`memories.tags` is `text[]` (`supabase/migrations/00001_memories.sql:11`) and Postgres has
neither operator for that type, so the query errors and `handleSearch` re-throws it as a 500;
only `is_set` / `is_not_set` are valid there, and both are degenerate on a
`not null default '{}'` column. This predates the REST-client work and is **not** fixed here —
a working `tags` condition needs the array operators (`cs` / `ov`) and a live-stack test,
which the token-gated `memories-api.integration.spec.ts` cannot supply from CI. Until then
`tags` remains in `ALLOWED_FILTER_FIELDS` (`filter.ts:26-33`) and in the `POST /search`
OpenAPI example (`packages/schemas/src/openapi/spec.ts:75`): both advertise more than the
code delivers.

Both filters are covered end-to-end in
`packages/mcp-server/src/memories-api.integration.spec.ts` → "list filters", against a live
stack. That is deliberate: the Storybook MSW handler reimplements both, so it can only ever
confirm itself — `handleList` threw on every `?tags=` request for a whole commit while that
suite was green.

## Filtering `GET /` — the provenance and authorship dimensions

Five more columns are filterable by value: `source_agent`, `trigger`, `origin_repo`,
`origin_branch`, `origin_pr`. Each takes a comma-separated list (split by the SAME
`parseTagsParam` as `tags`, so there is one splitting rule for every list-valued param) plus
its own `<column>_mode` of `in` (default) or `nin`.

- **The dimensions AND together, the values within one OR together.** Each is its own
  conjunct, which is what a flat filter bar can render; cross-dimension OR and nested groups
  belong in `POST /search`'s `filter` tree, which already expresses them.
- **The negation is `not.in`, never a chain of `neq`s.** They agree only while the column is
  NOT NULL and all five are nullable, so keeping the negation inside one operator is what
  stops the SQL disagreeing with the filter pill the user is reading.
- **One encoding, shared with `?q=`.** Both directions go through `.or()` with a single
  clause whose operand is built by `inListLiteral`, which quotes each value with the same
  `quoteFilterValue` the substring filter and the `filter` tree use. These columns are free
  text written by agents, so a value containing a `.`, a `()` or a double quote is reachable —
  each of which would otherwise terminate the `in.()` operand or break the quoting, and
  postgrest-js's own `.in()` quoting does not escape an embedded double quote. A COMMA is the
  one reserved character these params cannot carry: `parseTagsParam` splits on it first, so a
  comma-bearing value arrives as two values. `POST /search`'s `filter` tree is the way to
  express one.
- `origin_pr` is an `integer` column, so its values are filtered to digits (a non-numeric
  entry is DROPPED, not 400'd — the list arrives from a hand-editable URL and one bad entry
  should narrow the filter, not break the page) and emitted unquoted.
- `tags_mode` gained `none` — the negation of `any`, so `not.ov` and deliberately not
  `not.cs`: "carries none of these" is NOT(carries any), while NOT(carries all) would also
  admit a row carrying all but one.

## `GET /facets`

`lorekit_memory_facets` (00052, widened by 00057) returns `{ facets: [{ facet, value, count }] }`
for all eight dimensions — `tag`, `source_agent`, `trigger`, `kind`, `host`, `origin_repo`,
`origin_branch`, `origin_pr` —
ordered facet asc, count desc, value asc. `?archived=` partitions exactly as it does on
`GET /` and on `/tags`: a catalog must describe the population it will be used to filter.
`?facets=` narrows the response to named dimensions; an unknown name narrows to nothing
rather than 400ing, because the param is re-read on every keystroke in the dashboard's menu.

This is `/tags` generalised, and it overlaps it on purpose: `/tags` is the single-dimension
label catalog the CLI and older clients already call. Both read the same rows under the same
predicate, and `migrations.test.sql` §69 AC-7 executes the agreement rather than asserting it
in prose. Tenant scoping lives in the RPC, as it does for `/scopes` and `/tags` — there is no
query to scope here, and a second predicate would be somewhere for the two to drift.

A null column value yields NO facet row. An option that matches by absence would need an
`is not set` operator, which `GET /` does not have yet; offering the option without the
operator would be a row you can click and nothing happens.

**Counts are DRILL-DOWN as of 00057.** The route mirrors `GET /`'s filter params (`scope`,
`tags`/`tags_mode`, and a `<dim>`/`<dim>_mode` pair for each scalar dimension) and passes them
to the RPC, which counts each dimension with every OTHER active filter applied but NOT its own
— self-exclusion, so the dimension you are standing in still lists everything you could switch
to. With no filters supplied the response is the pre-00057 global catalog, unchanged. Two
consequences to know before reading a number:

- A value whose count falls to zero under the other dimensions' filters emits **no row**, the
  same omission a null column value has — so it drops out of the menu until the filter is
  cleared, rather than showing as a selectable `0`. Emitting the zeroes would mean returning the
  tenant's entire distinct value set for `tag` / `origin_branch` on every call.
- `q`, `key`, `created_since` and `created_until` are **NOT** mirrored, so with a search or date
  window active a count is an upper bound on what selecting the value would return, not the
  exact yield. Mirroring `q` would put a second implementation of `likeNeedle`'s LIKE escaping
  in plpgsql, which the repo-wide "a filter value is encoded ONE way" rule forbids.

## `seen_count` — recurrence, counted by the writer

Every route that returns a memory returns `seen_count`: how many times the lesson has been
written. It is part of `MEMORY_SELECT`, so `GET /`, `GET /:id`, `POST /search` **and the
write route `PATCH /:id`** all carry it, and `POST /` carries it through its own explicit
projection (`handlers/create.ts`). No route that hands back a memory omits the field.

**It is derived, never supplied.** `memory_write` has no `p_seen_count` parameter and gained
none in 00059 — the insert branches set `1` and each conflict-update branch sets
`seen_count = memories.seen_count + 1`. A write whose `(tenant, scope, key)` already resolves
to a live row *is* the second sighting, which is exactly the definition
`lorekit-setup`'s self-improvement loop documents ("a recurrence resolves to an UPDATE that
increments `seen_count` by 1"). Trusting a caller-supplied number would mean reading the row
back first and would let two concurrent writers clobber each other's count.

The increment reads `memories.seen_count`, not `excluded.seen_count`: `excluded` is the row
the INSERT proposed, which always carries the literal `1`, so an `excluded`-based increment
pins every recurrence at `2`.

**Reviving an archived key is not a recurrence.** All three conflict predicates are partial
on `archived_at is null` (00016), so writing an archived key inserts a fresh row starting at
`1` — the lesson was retired and is being learned again. This matches the `created_at`
semantics on that same path.

**Re-writing an expired key IS a recurrence, and that asymmetry is deliberate.** The predicates
exclude archived rows only, so an expired-but-unarchived row is still the row the conflict
resolves to and its count keeps climbing. Expiry is a *visibility* state — `expires_at` filters
the row out of every read (00030) but leaves it in the table until `purge_expired_memories`
hard-deletes it — whereas archiving is a retirement. Same key, same row, one more sighting; the
count restarts at `1` only once the purge has actually removed the row. Note the write does not
by itself make the row readable again: with no `ttl_seconds` and no `clear_ttl` the update branch
keeps the past `expires_at`, so the recurrence is counted on a row the reads still skip.

Rows written before 00059 read `1` (the column is `NOT NULL DEFAULT 1`, so the backfill is
the default and no data migration ran). The field is optional in `MemoryEntrySchema` for the
`kind`/`host` reason: a client reading from a backend deployed before 00059 sees it absent
rather than wrong.

Nothing filters or orders on it yet, so it carries no index — the same call 00048 made for
the `origin_*` columns.

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

## `GET /read-activity`

Memory **records read** per UTC hour or day, over a half-open `[since, until)` window — the
read counterpart to `/activity`:

```json
{
  "bucket": "day",
  "since": "2026-01-01T00:00:00.000Z",
  "until": "2026-07-19T00:00:00.000Z",
  "buckets": [{ "bucket": "2026-07-18T00:00:00.000Z", "count": 214 }]
}
```

| Param | Default | Meaning |
|-------|---------|---------|
| `bucket` | `day` | `hour` or `day` granularity — the same enum `/activity` takes. |
| `since` | `until` − 200 days | Inclusive lower bound. |
| `until` | now | **Exclusive** upper bound. |

**Records, not calls.** `count` is `sum(usage_events.result_count)` over the read tools
(`memory.read`, `memory.list`, `memory.search`, `memory.list_archived` — `permissions.ts`'s
`READ_TOOLS`), so one list call returning 20 memories
contributes 20 — the same call-vs-record distinction `GET /usage` draws between
`event_count` and `record_count`. It mirrors the memory read-FAMILY and deliberately not
`usage-stats.ts`'s broader `READ_TOOL_NAMES`, which also counts `memory.scopes`,
`memory.usage`, `org.list` and `member.list` — so `GET /usage`'s `records_read` is
legitimately larger than the sum of these buckets. That is what makes the series **additive**: the
dashboard's read sparkbar sums to its headline number, which a per-bucket distinct or
per-call count could not.

**Visibility is self-only.** Usage is a per-user ledger — `usage_events` has no `org_id`
and a co-member's reads are not the caller's activity — so `lorekit_read_activity`
(migration 00053) filters `user_id = caller` with the same `service_role` + NULL escape
hatch `lorekit_usage_stats` uses, and deliberately does **not** compose
`lorekit_member_org_ids` (that is the tenant predicate for `memories`, not for usage).
There is no `applyRestTenantScope` call for the `handleUsage` reason: there is no query to
scope.

Bucketing runs in Postgres for the `GET /scopes` reason, and `usage_events` is the
highest-volume table in the schema, so a client-side reduce over raw rows is the worst
case of the row-cap trap. `date_trunc` anchors buckets exactly where `/activity`'s do, so
a client can chart written and read volume on one aggregate grid. The response is sparse:
a bucket that read nothing is omitted.

Like `/scopes` and `/activity` there is **no MCP tool** — an aggregate read has no
scope-keyed MCP equivalent. Its `usage_events.tool_name` is `memory.read-activity`
(`rest-tool-name.ts`), which is itself NOT one of the read tools it aggregates, so
charting reads never inflates the read count.

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

`tags` is in that list but does not work: it is the one `text[]` column, and
`serializeFilterGroup` emits the `text` operators for it. See "`tags`" above — use the
top-level `tags` array (or `GET /memories?tags=`) instead.

```jsonc
{
  "filter": {
    "and": [
      { "field": "scope", "op": "is", "value": "global" },
      { "or": [
        { "field": "key",          "op": "contains", "value": "auth" },
        { "field": "source_agent", "op": "is",       "value": "claude" }
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
