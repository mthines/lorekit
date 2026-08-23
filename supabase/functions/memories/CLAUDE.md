# memories — REST memory CRUD

Handles all memory operations via HTTP. Auth is managed by the shared `resolveRestAuth` utility (service key, lk_ API token, or Supabase JWT).

## URL patterns

| Method | Path | Handler | Permission |
|--------|------|---------|------------|
| GET | / | list.ts | read |
| POST | / | create.ts | write |
| DELETE | / | remove.ts | write |
| POST | /list | list.ts | read |
| POST | /facets | facets.ts | read |
| POST | /activity | activity.ts | read |
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
`/list`, `/search`, `/restore`, `/purge`, `/purge-expired`, `/scopes`, `/tags`, `/facets`,
`/activity` and `/read-activity` all collide with `/:id`.
The literal routes are registered before the `/:id` routes in `index.ts` so a future
`POST /:id` cannot silently swallow them.

**A POST here does not imply a write.** `POST /list`, `POST /facets`, `POST /activity` and
`POST /search` are all `requires: 'read'` and none of them records an audit event — the verb
says "the request does not fit in a URL", not "this changes something". `audit-coverage.spec.ts`
pins that exact list, so a fifth read-only POST is a deliberate edit rather than a silent one.

## The body transport — `POST /list`, `POST /facets`, `POST /activity`

Each is the SAME read as the identically-named `GET`, decoded from a JSON body instead of a
query string. They exist because a query string is not a transport that carries an unbounded
filter bar:

- **Per dimension, 2048 characters.** `ValueListSchema` caps each comma-joined dimension, so
  how many values a dimension can hold depends on how long the values happen to be — with
  realistic ~28-character host names the wall lands between 50 and 75 selected values, and
  the UI can only render the resulting 400 as "Failed to load memories. Please refresh."
- **Per request, whatever the gateway allows.** Eight dimensions at 60 values each keeps
  every individual param legal and still builds an ~8 KB URL. That one fails with no LoreKit
  error envelope at all, which is the harder half to diagnose.

Raising the first cap only moves it and makes the second arrive first, which is why this is a
transport change and not a bigger number.

**The same wall existed one hop downstream, and 00067 is what removed it.** Moving the client
hop to a body was necessary and not sufficient: `handleList` still composed its predicates with
postgrest-js, whose `.or()` is a query param and whose `.select()` is a GET, so a dimension
carrying 200 values built a ~7 KB internal URL and the same gateway refused it — surfacing as a
`500` with nothing pointing at the filter that caused it. Both routes now read through the
`lorekit_memory_list` SQL function, which takes `text[]` parameters over a POST body, so the
value set never reaches a URL on either hop. `/facets` and `/activity` never had this problem:
they were already RPCs.

**The two transports cannot diverge, by construction.** Neither handler decides anything
about filtering, and since 00067 neither builds a query at all — both call `lorekit_memory_list`: `dimensionsFromQuery` and `dimensionsFromBody` (`_shared/schemas/dimensions.ts`)
both produce one `MemoryDimensions`, and a single predicate function turns THAT into SQL. The
decoders differ in exactly one thing — the query form splits on commas, the body form does not —
and share the trim / drop-empty / dedupe rule and `origin_pr`'s digits-only filter. Adding a
dimension is one field in `MemoryDimensions` and one line in the predicate, not two of each.

Body shape, versus the query form:

- Every dimension is a real **array** (`{"host": ["reviewer", "aw"], "host_mode": "in"}`),
  bounded at `FILTER_VALUES_MAX` (1000) values of `FILTER_VALUE_MAX_CHARS` (512) characters.
  The bound is explicit so it is a documented limit rather than an emergent one.
- **A value containing a comma is reachable here** and is not over `GET /` — the splitting is
  a property of the query wire format, and the whole reason the array form exists.
- `archived` is a real **boolean**, not the query form's `'true'`/`'false'` string enum.
- Everything else — `sort`, `limit` (still max 100), `cursor`, `q`, `key`, `key_prefix`,
  `created_since`/`created_until`, `expiring_within_days` — is identical, including defaults.
- The body is **optional**: a bodiless `POST /list` is the unfiltered first page, not a 400.

`GET /` stays fully supported and unchanged — the CLI, the MCP surface and every API-token
caller use it, and a link carrying a handful of filters is genuinely better as a URL. Only
the dashboard, whose filter bar is unbounded, reads over the body form.

Both forms report under the same `usage_events.tool_name` (`memory.list`, `memory.facets`,
`memory.activity`): one operation over two transports, so splitting the name would have
collapsed the existing series the day the dashboard switched.

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
requires at least one of `q`, `scopes` or `filter` (`packages/schemas/src/domain/memory.ts:265`) and
the `tags` array is none of the three, so a `tags`-only body is a 400 `Validation failed` —
pair it with a `q` or a `scopes` list.

**The `filter` tree is not a second route to a `tags` predicate.** `serializeFilterGroup` has
no per-column type dispatch (`packages/schemas/src/shared/filter.ts:136-154`), so a condition naming
`tags` serialises as if the column were `text`: `tags.ilike."%x%"` for the pattern operators
(asserted verbatim at `packages/schemas/src/shared/filter.spec.ts:75`) and `tags.eq."x"` for `is`.
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
`packages/smoke-tests/src/memories-api.integration.spec.ts` → "list filters", against a live
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
- **The negation is one operator, never a chain of `neq`s.** They agree only while the column
  is NOT NULL and all five are nullable, so keeping the negation inside one operator is what
  stops the SQL disagreeing with the filter pill the user is reading. `lorekit_match_text` /
  `lorekit_match_int` (00066) are where that now lives; `nin` there excludes a NULL row for
  the same reason.
- **No PostgREST operand is composed for these dimensions any more.** Both directions used to
  go through `.or()` with a single clause built by `inListLiteral`, quoting each value with
  the same `quoteFilterValue` the substring filter and the `filter` tree use — because these
  columns are free text written by agents, so a value containing a `.`, a `()` or a double
  quote is reachable, each of which would otherwise terminate the `in.()` operand or break
  the quoting. 00067 moved the whole read into `lorekit_memory_list`, which takes the values
  as real `text[]` parameters, so there is no operand to quote and **`inListLiteral` has no
  callers left**. A COMMA remains the one reserved character the QUERY form cannot carry:
  `parseTagsParam` splits on it first, so a comma-bearing value arrives over `GET /` as two
  values — the body form (`POST /list`) carries it intact, and `POST /search`'s tree is the
  express one.
- `origin_pr` is an `integer` column, so its values are filtered to a BOUNDED run of digits —
  a non-numeric entry is DROPPED, not 400'd (the list arrives from a hand-editable URL and one
  bad entry should narrow the filter, not break the page), and so is an all-digit entry too
  wide for int4, which would otherwise raise 22003 instead of dropping.
- `tags_mode` gained `none` — the negation of `any`, so `not.ov` and deliberately not
  `not.cs`: "carries none of these" is NOT(carries any), while NOT(carries all) would also
  admit a row carrying all but one.

## Filtering `GET /` — `?expiring_within_days=` ("expiring soon")

`?expiring_within_days=N` (integer, 1–365) keeps only memories whose TTL runs out inside the
window `(now, now + N days]`. The bounds come from the shared pure `expiringWindow`
(`packages/mcp-core/src/limits/expiring-window.ts` ↔ `_shared/expiring-window.ts`, drift-guarded by
`edge-parity.spec.ts`), never computed inline — the boundary rules below ARE the feature, and an
off-by-one here does not throw, it shows a row that already expired.

- **The lower bound is EXCLUSIVE, the upper INCLUSIVE** — deliberately the opposite asymmetry
  from this codebase's usual `[since, until)`. The lower is not a window edge at all: it is the
  definition of "live" (`expires_at > now()`, the same predicate the live branch and
  `lorekit_purge_all_expired_memories`'s complement use), so an inclusive one would surface rows
  the next request refuses to return. The upper is inclusive because "within 7 days" plainly
  includes something expiring at the 7-day mark.
- **TWO predicates, not three.** There is no `expires_at is not null` clause: `null > x` and
  `null <= x` are both SQL `NULL`, so a memory with no TTL fails the comparison and drops out on
  its own. The reassuring-looking third clause would be dead weight the planner still carries.
- **The `> now` bound is re-stated rather than inherited from the live branch**, which only runs
  for `archived=false`. Without it, `?archived=true&expiring_within_days=7` would return
  already-expired archived rows.
- **It composes, it does not override.** With the default `archived=false` it narrows live rows
  (the only combination the Explorer's Status control produces); combined with `archived=true` it
  reads as "archived AND expiring soon" rather than 400ing — a filter that rejects a combination
  its own grammar can express is a worse surprise than an empty page.
- **No new index.** The two comparisons range-scan `memories_expires_at_idx` (00030), whose
  partial predicate is exactly the row set they select. `migrations.test.sql` §75 asserts that
  index still exists and is still partial, since this filter silently degrades to a seq scan on
  the largest table if it is ever dropped or widened.
- The 1–365 bound is spelled in BOTH `ListMemoriesQuerySchema` and `expiring-window.ts` —
  `@lorekit/schemas` depends on nothing by design, the same arrangement `ttl_days` /
  `TTL_MIN_DAYS` has. Unlike that one, the two are tied by an executable guard
  (`expiring-window.spec.ts` → "agreement with ListMemoriesQuerySchema"), so a drift that would
  turn a rejected value into a 500 fails a test instead.

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

The eight text/tags/int dimension predicates are the shared inlinable SQL helpers
`lorekit_match_text` / `lorekit_match_tags` / `lorekit_match_int` (migration 00066), so the
catalog's per-dimension flags cannot drift from the series `GET /activity` counts: **all three
of `lorekit_memory_facets`, `lorekit_memory_activity` and `lorekit_memory_list` compose the
same helpers**, so the load-bearing `nin` null test (an unattributed row is EXCLUDED from a
negated filter, not silently dropped) lives in ONE place for every dimension reader. `GET /`
and `POST /list` (`list.ts`) used to be a **separate** implementation building a PostgREST
`not.in` predicate (`inListLiteral`); 00067 folded them onto `lorekit_memory_list`, so they
are unified with the other two rather than merely agreeing by construction, and both
transports share that one predicate. `owner` is the one dimension that stays
inline in the RPCs: it is a LEFT JOIN-computed identity (`personal` / org slug), not a scalar
column.

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
hard-deletes it — whereas archiving is a retirement. Same key, same row, one more sighting; the run
ends when the row does, which for a **personal** row means either the purge hard-deleting it or an
archive retiring it — the categorical rule above, not a second mechanism. Either way the next write
starts a fresh row at `1`. Note the write does not by itself make the row readable again:
with no `ttl_seconds` and no `clear_ttl` the update branch keeps the past `expires_at`, so the
recurrence is counted on a row the reads still skip.

**Expiry alone never ends that run for an org- or service-owned row, because the purge never reaches
it.** `purge_expired_memories` deletes `where user_id = v_actor` (00046), and both the org branch and the
service branch of `memory_write` insert `user_id null` — `null = <anything>` is never true, so no
actor value can match and an expired org/service row is never hard-deleted. Its `seen_count`
therefore keeps climbing on a row every read skips, for as long as the row is only *expired*.

**Archiving still ends it, for every tenancy — the two paragraphs above are about expiry, not about
the row class.** `memory_delete` stamps `archived_at` on a personal row through its personal branch
and on an org row through its org branch (00020, actor-guarded in 00046), and the non-org path in
`handlers/remove.ts` / `mcp/tools.ts` applies its tenant filter only for `api_key` auth (and only
when it has a `userId`), so a service-role caller reaches a service-owned row. In every one of those
cases the partial conflict predicates stop seeing the row and the next write inserts a fresh one at
`1` — the archived-key rule above, which *is* categorical. `?force=true` deletes the row outright on
all of these paths, with the same effect on the next write.

The purge gap itself is in the actor guard and predates 00059; this column only makes it observable.
Widening the purge is deliberately **not** done here: `user_id = v_actor` is the actor guard 00046
added on purpose to a `security definer` RPC, so relaxing it is a tenancy change that needs its own
migration and its own cross-tenant assertions.

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

## `GET /relevant`

The one verb that **ranks**. Returns the top-K lessons for a query as a compact index:

```json
{
  "entries": [
    {
      "scope": "repo::acme/app",
      "key": "migration-order",
      "hook": "Always add the column before the backfill runs.",
      "score": 0.74,
      "factors": { "recency": 0.61, "salience": 0.85, "relevance": 1, "outcome": 0.5 },
      "seen_count": 9,
      "updated_at": "2026-07-30T09:12:00.000Z"
    }
  ],
  "candidates": 47
}
```

| Param | Default | Meaning |
|-------|---------|---------|
| `q` | — | Free-text query, `websearch` FTS over `key \|\| value`. **Optional.** |
| `scopes` | all visible | Comma-separated, **most-specific first** — the order breaks ties. |
| `limit` | `10` | 1–50. A shortlist for a context window, not a page. |
| `min_score` | `0` | Drop hits below this — how a caller says "stay silent rather than show me something weak". Note: with `q` set, matched hits floor at `(1 + 0.5) / 4 = 0.375` (relevance is binary and outcome never sinks below its `0.5` prior today), so `min_score ≤ 0.375` is a no-op until graded relevance. |

**Why it exists.** Every other read hands the caller a single-signal ordering — `GET /memories`
is `updated_at` desc, `POST /memories/search` is FTS rank — and neither knows that a lesson
written twelve times is worth more than one written once. Each client that wanted a useful
shortlist fetched a page and re-sorted it locally, which is three copies of a ranking and
three chances to disagree about what matters.

**Two phases, and the split is the design.** Postgres SELECTS the candidates (an index scan
over `fts` is the difference between reading 40 rows and reading the whole store); the shared
scorer ORDERS them in TypeScript. The ranking is deliberately *not* SQL: it is set-relative
(salience normalises against the most-recurring candidate) and it must agree exactly with the
CLI hook's ordering. A plpgsql copy could not be held to that agreement by any test, whereas
`lesson-rank-parity.spec.ts` holds `_shared/lesson-rank.ts` to the CLI's `lessons-pure.mjs`
behaviourally — same scores, same order, over shared fixtures.

**`q` is optional on purpose.** With it, relevance participates and the answer is "what
matters for this task". Without it, the ranking is recency + salience, which is "what matters
generally" — the SessionStart question. Requiring `q` would have forced the hook to invent a
query for a session that has not asked anything yet.

**Relevance is currently binary, and that is an honest limit.** `ts_rank` is not projectable
through PostgREST's query grammar, so a row that matched scores 1 and — since a non-matching
row is never returned — nothing scores between. Ordering among matches is therefore decided by
recency and salience, which is the useful half: *these all mention your terms; here are the
ones that keep mattering.* A graded relevance needs an RPC returning `ts_rank`, which is where
the semantic-search work has to go anyway.

**`CANDIDATE_LIMIT = 200`** bounds the pre-ranking fetch. The ranking needs a population, not
just the page it returns — salience is normalised across candidates, so a genuinely recurring
lesson ranked 30th by FTS must still get the chance to come first. 200 is comfortably above
the route's own `limit` cap of 50 while staying one cheap indexed read.

The response carries `candidates` (how many the FTS matched before ranking) so a caller can
say "3 of 47" instead of implying it saw everything — the same reason the SessionStart block
reports its own truncation.

Bodies are never returned. The point of the route is deciding *which* few lessons deserve
attention; returning the full text of ten of them would spend the context it just saved. Fetch
what you want with `GET /:id` or `memory.read`.

There is **no MCP tool** for this yet. `usage_events.tool_name` is `memory.relevant` — its own
name rather than folding into `memory.search`, because the two answer different questions and
collapsing them would make it impossible to tell whether agents actually reach for the ranking.

## `GET /scopes`

Returns every distinct scope the caller can see with its count of active (non-archived,
non-expired) memories, ordered by **count desc then scope asc** (migration 00065, the same
frequency-first order `/tags` uses) — so the busiest scope leads. The dashboard's scope chip
strip renders this order directly (`fetchScopes` never re-sorts), which is why the order lives
in the RPC:

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

The series also takes `scope` + the same dimension filters `GET /` and `GET /facets` take
(migration 00063) plus the `owner` dimension (00064), so the Explorer's stat header agrees
with the list beneath it. The eight text/tags/int predicates are the shared helpers
`lorekit_match_text` / `lorekit_match_tags` / `lorekit_match_int` (migration 00066) — the same
predicates `lorekit_memory_facets` composes, so the chart and the facet menu narrow
identically; `owner` stays inline. With no filters supplied the response is byte-for-byte the
pre-00063 aggregate.

## `GET /read-activity`

Memory **records read** per UTC hour or day, over a half-open `[since, until)` window — the
read counterpart to `/activity`:

```json
{
  "bucket": "day",
  "since": "2026-01-01T00:00:00.000Z",
  "until": "2026-07-19T00:00:00.000Z",
  "buckets": [
    { "bucket": "2026-07-18T00:00:00.000Z", "scope": "repo::mthines/lorekit", "count": 214 },
    { "bucket": "2026-07-18T00:00:00.000Z", "scope": null, "count": 9 }
  ]
}
```

| Param | Default | Meaning |
|-------|---------|---------|
| `bucket` | `day` | `hour` or `day` granularity — the same enum `/activity` takes. |
| `since` | `until` − 200 days | Inclusive lower bound. |
| `until` | now | **Exclusive** upper bound. |
| `scope` | — | Restrict to one **exact** scope. Invalid ⇒ `400`. |

**One row per `(bucket, scope)`** (migration 00058), mirroring `/activity`. `scope` is
**nullable** here where `/activity`'s is not: a write always happens under a scope, while a
read may carry none the server can resolve — the router reads `?scope=` from the query
string only (it must not consume the request body), and an ungrammatical value is recorded
as unattributed rather than failing the call it is measuring. Those rows are still counted,
so the unfiltered series remains the complete account total.

Consequently a **per-scope total can be smaller than the account total**, and the
difference is the unattributable reads. Any UI showing both should say so rather than let
the numbers look like a bug.

`?scope=` is an exact-match filter, and because the metric is additive its buckets **sum to
the per-scope headline** — which is why there is no companion "per-scope total" RPC. A
second function computing the same number would be free to drift from the bars drawn above
it, the exact property this series exists to guarantee.

**The two scope paths fail in opposite directions, on purpose.** Recording a scope
(`safeValidateScope`, `_shared/scope.ts`) is a measurement taken alongside an operation the
caller asked for, so a bad value degrades to `null` and never breaks it. Filtering by a
scope is the question itself, so a bad value is a `400` — silently dropping a typo'd filter
would answer "reads everywhere" under the label the caller asked for. Same call as
`?correlation_id=`. Both sides go through the **canonical** `validateScope`; there is no
second grammar.

**That rule now holds on every scope-filtering route, not just this one.**
`GET /`, `GET /activity`, `GET /facets`, `GET /read-activity`, `DELETE /?scope=…&key=…`
and `POST /restore` all reject an ungrammatical `?scope=` with a `400`. **So do the body
transports** `POST /list`, `POST /activity` and `POST /facets`: each decodes into the same
module-private reader as its `GET` twin (`respondWithPage` / `runActivity` / `runFacets`),
which is where the filter is validated — that is what stops the two transports disagreeing
about which scopes are legal, and it means the rule covers a `scope` in the JSON body
exactly as it covers one in the query string. (`POST /` — the write path — is untouched: it
stores `scope`, it does not filter by it.) They previously
passed the raw value into the predicate, so a bad scope matched nothing and the route
answered `200` with an empty page — the same input getting a `400` from one route and a
cheerful empty result from five others. The shared entry point is
**`parseScopeFilter`** (`_shared/scope.ts`).

`parseScopeFilter` **rejects without normalising**, and that is deliberate: `validateScope`
lowercases, but the write path does not (`CreateMemoryBodySchema` binds `RawScopeSchema`,
`handlers/create.ts` passes `body.scope` verbatim, and no migration lowers it), so
`memories.scope` legitimately holds mixed-case values. Lowercasing a *filter* would make
those rows unmatchable by `GET /` and undeletable by natural key. If the write path is ever
normalised, normalise the filters in the same change — never before. It also **rejects
surrounding whitespace**: `validateScope` trims before it checks, so a padded value is
grammatical to it while the untrimmed string reaches the predicate and matches nothing —
the same empty-page failure, so it is named as bad input rather than silently trimmed. This
applies to the `parseScopeFilter` routes only: `GET /read-activity` compares the NORMALISED
value, so padding is trimmed there and `?scope=%20global` is a legitimate `200`.

**`GET /read-activity` is the one route that still normalises, and must keep doing so.** It
filters `usage_events.scope`, which is written through `safeValidateScope` at the recording
site (`_shared/api/router.ts`) and is therefore already lowercased; a reject-only filter
there would miss every mixed-case request. The six routes share the GRAMMAR; the case rule
follows whichever path wrote the column. `scope-filter-validation.spec.ts` pins the required
validator per handler, so neither direction can be "harmonised" into stranding rows.

The array-valued `?scopes=` paths (`POST /search`, `GET /relevant`) are **not** covered:
they need a per-entry decision — reject the whole request, or drop the bad entry — that has
not been made yet. The MCP twin (`mcp/tools.ts`) validates each entry, so that is the
precedent to reconcile against when it is.

`safeValidateScope` is hand-mirrored between `packages/mcp-core/src/scope/scope.ts` and
`supabase/functions/_shared/scope.ts` and is **not** covered by `edge-parity.spec.ts` —
that file is excluded from `MIRRORS` because the two `validateScope` bodies deliberately
differ. The wrapper delegates every grammar decision to whichever one is in scope, so the
difference propagates instead of being duplicated. Keep the two wrappers in step by hand.

**Deferred (R10):** `purge_expired_memories` (00045) is untouched. Its `memory.expired`
event is per-user and spans every scope that user owns, so there is no single scope to
attribute it to — those events stay `scope IS NULL`, asserted in `migrations.test.sql` §74.

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
`packages/mcp-core/src/telemetry/usage-stats.ts`) from the SAME rows returned as `by_tool`,
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
  (`list`/`search`/`get`) set it to the number of records they returned, and the
  DELETE handler sets it on **both** branches (the personal one from the
  mutation's affected-row count, the `?org=` one to `1` — `memory_delete` is
  keyed on a unique natural key and a miss 404s). The router reads it once
  (`RESULT_COUNT_HEADER`) and records it as the event's `result_count`.
  Fail-safe: an absent/garbage value records no count, never breaks the request.
  The MCP handler computes the same figure from the tool result via
  `countRecords`. Note the usage summary still counts `archived` by EVENT — rows
  written before the DELETE handler set this header carry a NULL count.

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
