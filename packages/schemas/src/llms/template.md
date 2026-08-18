# LoreKit

> Shared, persistent memory for AI coding agents. Lessons survive session ends, machine reboots, and CI runs — stored in Supabase Postgres and served over MCP. Agents read relevant lessons at task start and write new ones when they learn something worth keeping.

## Quickstart (hosted — fastest path)

1. Sign in at https://lorekit.io with GitHub
2. Go to Overview → Connect your agent → Generate new token (choose Read + Write)
3. Copy the token (shown once)
4. Connect your agent:

```bash
npx @lorekit/cli install \
  --endpoint https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp \
  --token    lk_rw_<your-token>
```

5. Verify: `npx @lorekit/cli doctor`

`install` asks whether to wire the Claude Code lifecycle hooks. They inject
context into the agent — none of them writes memory (the write is still the
model calling `memory.write`). Three modes, selectable non-interactively with
`--hooks <mode>`:

- `all` — `SessionStart` (inject lessons), `UserPromptSubmit` (inject the few
  that match what you just typed, if any), `PostToolUseFailure` and `Stop`
  (nudge to record one). Preselected on a fresh install.
- `read-only` — `SessionStart` only: lessons are injected ONCE, nothing ever
  nudges, and nothing runs per turn.
- `none` — skills + MCP only; memory stays model-invoked.

`UserPromptSubmit` fires on every prompt, so it is deliberately quiet: it skips
trivial prompts, stays silent when nothing matches, and never re-shows a memory
already injected this session. `hooks.userPrompt: "off"` disables just that
event while keeping the rest of `all`.

An interactive re-run preselects whatever is already wired, so it never
resurrects hooks you declined. `--yes` / a non-TTY run takes that same
preselected value without asking — `all` on a fresh install, otherwise whatever
is already wired, and a hand-wired set matching no preset keeps exactly that set
(no event is added or removed; a stale hook command is still refreshed) — so
pass `--hooks <mode>` when you need a specific wiring.
`--hooks none` removes hooks that are already there; the older `--no-hooks` flag
only skips wiring new ones. `npx @lorekit/cli doctor` reports which events are
wired and in which scope.

The `SessionStart` block is bounded by a character budget
(`hooks.sessionStart.maxChars`, default 3000 — roughly 25 index lines) and, from
the other direction, by a line count (`hooks.sessionStart.maxLessons`, default
100, range 3–200) — whichever binds first, which at the default budget is almost
always `maxChars`. `maxLessons` is therefore best read as the DEPTH of the read:
it sets the per-scope candidate fetch (100 memories per scope by default, capped
at the API's 100-per-page maximum), so the ranker picks its ~25 rendered lines
from up to 400 candidates rather than from the newest handful. Memories are
ranked by recurrence and recency, then de-duplicated, before the budget is spent. A header
reading `9 of 50 memories loaded` means the block was truncated — the trailing
`More lore: …` line names which scopes hold the rest, and `memory.search` /
`memory.read` reach them. `hooks.sessionStart` picks the shape:
`hybrid` (default, list + that map), `index` (list only) or `map`
(map + the three most salient).

Full self-hosting guide (your own Supabase + Vercel): https://github.com/mthines/lorekit/blob/main/docs/install.md

## Local mode (offline, no account)

Run the MCP server against plain markdown files on disk — no endpoint, no token:

```jsonc
{
  "mcpServers": {
    "lorekit": { "command": "npx", "args": ["-y", "@lorekit/cli", "mcp"] }
  }
}
```

Set `LOREKIT_MODE=local` or add `{ "mode": "local" }` to `.lorekit.json` at the repo root.
Lessons are stored in `~/.lorekit/` (global tier) and `<repo>/.lorekit/` (repo tier, commit or gitignore).

## MCP endpoint

```
https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp
```

Auth: `Authorization: Bearer <token>` — token prefix encodes permissions (see Tokens below).

## Tokens

```
lk_rw_<32 chars>   # read + write
lk_ro_<32 chars>   # read only
lk_wo_<32 chars>   # write only
```

Tokens never expire unless revoked. Stored as SHA-256 hashes — shown once on creation.
Maximum 20 tokens per account. Generate and revoke at lorekit.io.

A revoked token is rejected with HTTP 401 (`{"error":"Authentication required","code":"unauthorized"}`)
on REST and `-32001` on MCP. `npx @lorekit/cli doctor` verifies this directly: its
`connectivity` check probes the public `/health` function (network path only) and its
`authentication` check makes one authenticated request — `PASS` when the token is accepted
(including a `lk_wo_*` token answered 403 on a read), `FAIL` on 401. Replace a revoked token
with `npx @lorekit/cli install --force`, which offers to keep, replace, or remove the stored one.

### Permission matrix

{{PERMISSION_MATRIX}}

## Scope format

`::` is the only valid separator. Segments are lowercased on ingest.

| Type | Format | Example |
|------|--------|---------|
| Global | `global` | `global` |
| Project (monorepo) | `project::{name}` | `project::agent-skills` |
| Repository | `repo::{owner}/{repo}` | `repo::mthines/gw-tools` |
| Branch | `branch::{owner}/{repo}::{branch}` | `branch::mthines/gw-tools::feat/x` |

Validation: single `:` → 400; `repo::` without `/` → 400; `branch::` without two `::` → 400; unknown prefix → 400; a segment containing a further `::` → 400 (`::` is reserved as the separator).

The same grammar applies when a scope is used as a FILTER, not just when it is written. `GET /memories`, `GET /memories/activity`, `GET /memories/facets`, `GET /memories/read-activity`, `DELETE /memories?scope=…&key=…` and `POST /memories/restore` all answer **400** for an ungrammatical `?scope=`. They previously passed the raw value through, so a bad scope matched nothing and the route answered `200` with an empty page (or, on delete/restore, `404`) — the same input getting a 400 from one route and a cheerful empty result from the others. A scope filter is the question being asked, so a malformed one is rejected rather than answered with a different question's result.

Filters are validated but **not** normalised: the write path stores `scope` verbatim over REST, so a filter matches exactly the string that was written. Lowercasing a filter would make a mixed-case row unmatchable by `GET /memories` and undeletable by its natural key. The array-valued `scopes` of `POST /memories/search` and `GET /memories/relevant` are not covered by this yet.

### Scope resolution (read order)

Query narrow → broad and merge. More-specific scope wins when the same key exists at multiple levels:

```
branch::{owner}/{repo}::{branch}   # most specific
repo::{owner}/{repo}
project::{name}                    # monorepo
global                             # least specific
```

### Wildcard search

`memory.search` accepts `"scopes": ["repo::mthines/*"]` (owner-level wildcard). Wildcards only work in `memory.search`.

## MCP tools

{{MCP_TOOLS}}

## Organizations & shared lore

- Every memory is personal by default. Add `org` to `memory.write` to write org-owned lore.
- All org members with read access see org-owned lore in their reads.
- Roles: `viewer` (read only), `member` (read + write/archive/restore), `admin` (+ hard-delete + invite management), `owner` (+ rename/delete org).
- Scope→org binding: an admin can bind a scope to the org — subsequent writes under that scope auto-route to the org for write-capable members. Non-members fall back to personal (never rejected) with a `notice`.
- Manage orgs and members at lorekit.io → Settings → Organization.

## Filtering lore (dashboard Explorer + REST)

The Explorer at lorekit.io/lore filters on eight dimensions. Values combine with **OR inside one
dimension** and **AND across dimensions**, and the whole filter set is in the URL, so a filtered
view is a shareable link.

| Dimension | Memory field | Operators |
|-----------|--------------|-----------|
| Label | `tags` | includes all (default), includes any, includes none |
| Kind | `kind` | is / is either of, is not |
| Host | `host` | is / is either of, is not |
| Agent | `source_agent` | is / is either of, is not |
| Trigger | `trigger` | is / is either of, is not |
| Repository | `origin_repo` | is / is either of, is not |
| Branch | `origin_branch` | is / is either of, is not |
| Pull request | `origin_pr` | is / is either of, is not |

The same filters are on the REST list route, so an agent or the CLI can ask the same questions:

```bash
# Everything the `aw` agent learned on a branch, excluding one label
curl -H "Authorization: Bearer lk_ro_…" \
  "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/memories?\
source_agent=aw&origin_branch=main&tags=flaky&tags_mode=none"
```

Each dimension takes a comma-separated value list plus an optional `<dimension>_mode` of `in`
(default) or `nin` (negate); labels use `tags_mode` of `any` (default), `all`, or `none`.

`kind` and `host` are the memory TAXONOMY: `kind` is the bucket type — a closed vocabulary of
`lesson`, `bus` and `signal` — and `host` is the skill or agent that owns the bucket. Together they
read as the phrase they exist for: `?kind=lesson&host=reviewer` is "reviewer's lessons". Note that
`host` is not `source_agent`: the host OWNS the bucket, the agent WROTE the row, and they can
differ.

### Finding lore that is about to expire

`?expiring_within_days=N` (1–365) narrows the list to memories whose TTL runs out soon — those
with an `expires_at` strictly after now and at or before now + N days. Memories with no TTL are
never included, and neither are ones that have already expired.

```bash
# What am I about to lose this week?
curl -H "Authorization: Bearer lk_ro_…" \
  "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/memories?expiring_within_days=7"
```

It is a relative horizon on purpose: "expiring in the next 7 days" still asks the same question
tomorrow, where a saved link with an absolute date would quietly become a view of the past. Use it
to review what is about to lapse and either let it go or refresh the TTL with `memory.write`
(`ttl_days`, or `clear_ttl` to make it permanent).

`GET /memories/facets` returns every filterable value with its memory count
(`{ "facets": [{ "facet": "origin_branch", "value": "main", "count": 27 }] }`), partitioned by
`?archived=true|false` and narrowable with `?facets=tag,trigger`. Use it to discover what can be
filtered on instead of listing memories and tallying them client-side — the tally is silently
truncated past the row cap.

### When the filters do not fit a URL (`POST /memories/list`, `/facets`, `/activity`)

Each of those three reads has a POST twin taking the SAME filters in a JSON body:

```bash
curl -X POST -H "Authorization: Bearer lk_ro_…" -H "Content-Type: application/json" \
  -d '{"scope":"global","host":["reviewer","aw"],"host_mode":"in","limit":50}' \
  "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/memories/list"
```

Reach for these when a dimension carries more values than a query string can hold, or when a
value contains a comma. The query form joins a dimension's values into one comma-separated
parameter capped at 2048 characters, so how many values fit depends on how long they happen to
be, and a comma inside a value is read as a separator. In the body every dimension is a real
array (`"host": [...]`, with its `host_mode`) bounded by a COUNT — 1000 values of up to 512
characters each — and a comma is just a character. `archived` and `limit` take their real JSON
types (`true`, not `"true"`).

Both transports decode to one filter shape server-side and report under the same
`memory.list` / `memory.facets` / `memory.activity` usage name, so the choice is purely about
what fits. The GET forms are unchanged and remain the right call for anything link-shaped. The
body is optional — a bodiless `POST /memories/list` is the unfiltered first page, not an error.

## Which lore matters right now (`GET /memories/relevant`)

Listing and searching tell you what EXISTS. They do not tell you what is worth reading:
`GET /memories` orders by `updated_at`, `POST /memories/search` by full-text match, and neither
knows that a lesson learned twelve times matters more than one written once. On an active repo
that difference is the whole game — the newest writes are usually one task's iteration log.

`GET /memories/relevant` is the ranked shortlist. It scores each candidate on **recency**
(exponential decay, 14-day half-life), **salience** (`log1p(seen_count)`, normalised across the
candidates), **relevance** (full-text match on `q`) and **outcome** (applied/resolution history —
`1` on an outcome bus, `0.75` carried to a PR, `0.5` cold-start prior when unproven), and returns a
compact index:

```bash
curl -H "Authorization: Bearer lk_ro_…" \
  "https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/memories/relevant?\
q=migration+backfill&scopes=repo::acme/app,global&limit=5"
```

```json
{
  "entries": [
    { "scope": "repo::acme/app", "key": "migration-order",
      "hook": "Always add the column before the backfill runs.",
      "score": 0.74, "factors": { "recency": 0.61, "salience": 0.85, "relevance": 1, "outcome": 0.5 },
      "seen_count": 9, "updated_at": "2026-07-30T09:12:00.000Z" }
  ],
  "candidates": 47
}
```

| Param | Default | Meaning |
|-------|---------|---------|
| `q` | — | Free-text query. **Optional** — omit it and the ranking is recency + salience, i.e. "what matters generally". |
| `scopes` | all visible | Comma-separated, **most-specific first**; the order breaks ties, so a project lesson wins over the global one it ties with. |
| `limit` | `10` | 1–50. |
| `min_score` | `0` | Drop weak hits when injecting automatically — an irrelevant lesson every turn is worse than none. Note: with `q` set, matched hits floor at `(1 + 0.5) / 4 = 0.375` (relevance is binary and outcome never sinks below its `0.5` prior today), so a value ≤ `0.375` is a no-op; finer gating arrives with graded relevance. |

Bodies are not returned — fetch the ones you want with `memory.read`. `candidates` is how many
matched before ranking, so you can tell a shortlist from the whole set.

## Limits

| Limit | Default |
|-------|---------|
| Active memories per user | 5,000 |
| Requests per minute per user | 120 |

Archiving a lesson frees cap headroom immediately. Service-role / CI tokens are exempt.
When the cap is hit, `memory.write` returns a `memory_cap` error with instructions.
Rate-limited requests receive HTTP 429 with a `Retry-After` header.

## Error codes

| JSON-RPC code | Meaning |
|---------------|---------|
| `-32001` | Unauthorized — missing, invalid, expired, or wrong-permission-tier token (e.g. read-only token on a write, write-only token on a read) |
| `-32003` | Forbidden — authenticated, but not permitted for this tool (e.g. an `lk_*` token calling an `org.*` tool) |
| `-32603` | Execution error — DB error, scope validation failure, org permission denied (`LK002`), or memory cap exceeded (`LK001` / `memory_cap`) |
| `-32700` | Parse error — malformed JSON body |
| `-32601` | Unknown tool name |

## Architecture

- **MCP server** — Supabase Edge Function (Deno), endpoint `/functions/v1/mcp`
- **Web dashboard** — Next.js 15 on Vercel at `lorekit.io`
- **Database** — Supabase Postgres with row-level security and full-text search
- **CLI** — `@lorekit/cli` (Node, zero-dependency ESM, works offline)

## Guides

{{DOCS_INDEX}}

## Key documentation

- MCP tools reference: https://github.com/mthines/lorekit/blob/main/docs/mcp-tools.md
- Scope format: https://github.com/mthines/lorekit/blob/main/docs/scope-format.md
- API tokens: https://github.com/mthines/lorekit/blob/main/docs/api-tokens.md
- Limits: https://github.com/mthines/lorekit/blob/main/docs/limits.md
- Organizations & sharing: https://github.com/mthines/lorekit/blob/main/docs/org-sharing.md
- Deployment / self-hosting: https://github.com/mthines/lorekit/blob/main/docs/install.md
- CLI reference: https://github.com/mthines/lorekit/blob/main/packages/cli/README.md
- Plugins (Claude / Cursor / Codex): https://github.com/mthines/lorekit/blob/main/plugins/README.md
