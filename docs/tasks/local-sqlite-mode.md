# Proposal: local mode on SQLite — dashboard and usage data without Supabase

> Status: **proposal / not started** · Area: CLI, web, REST contract · Size: **L** (phased)
> Companion to the BYOD fix that generated `supabase/byod/bootstrap.sql` from the
> migrations. Nothing in this document is built yet; it is here to be argued with
> before any code lands.

## Problem

There are two ways to run LoreKit today, and neither gives one person a
dashboard without Supabase:

- **Offline store** — markdown files under `~/.lorekit` and `<repo>/.lorekit`
  (`packages/cli/src/store/local.mjs`), served to agents by the local stdio MCP
  server `lorekit mcp`. No account, no network — but no dashboard, no read
  counters and no usage events, so `/insights` has nothing to show.
- **Hosted or self-hosted** — the dashboard, REST API and MCP server all sit on
  Supabase: Postgres, Supabase Auth and Edge Functions. Self-hosting means your
  own Supabase and Vercel projects ([install.md](../install.md)); BYOD only moves
  memory rows to a second Supabase project ([byod.md](../byod.md)).

The goal: run LoreKit on one machine, browse lore in the dashboard and read
usage data, with no Supabase — for local development and single-user
self-hosting.

## What makes this hard

The server logic lives in Postgres, not in TypeScript:

| Fact (measured on `main` at 00113) | Consequence for SQLite |
|---|---|
| 108 migrations define 87 SQL functions; the edge functions call **48** distinct RPCs | Each RPC a route needs must be re-implemented |
| The Explorer's routes rest on ~1,200 lines of PL/pgSQL (`lorekit_memory_list` 206, `_facets` 218, `_activity` 136, `memory_write` 245, `memory_delete` 157, …); Insights on ~690 more (`lorekit_usage_stats`, `_usage_runs`, `_read_activity`, `_memory_pivot` 158, `_utility_*`, …) | That is the size of a second implementation |
| `lorekit_memory_list`, `_facets`, `_activity` and `_pivot` were all redefined in the newest migration (00113) | A second implementation drifts at that rate unless something forces parity |
| Full-text search is `tsvector` + `websearch_to_tsquery`; graded relevance is `ts_rank_cd` by decision | SQLite FTS5 ranks with `bm25` — ordering will differ, and must be documented as a local-mode difference, not relitigated for hosted |
| Labels are `text[]` with containment/overlap; RLS and `auth.uid()` scope every read | JSON arrays + `json_each`; single user, so tenant scoping collapses to one fixed id |
| Edge handlers speak PostgREST's query builder and `.rpc()`, not a repository interface | There is no seam to swap a SQLite client in behind the existing handlers |
| The dashboard reads memories and analytics through the REST API (`packages/web/src/lib/api/`, base URL derived from `NEXT_PUBLIC_SUPABASE_URL` in `rest.ts`), but signs in with Supabase Auth (`middleware.ts`, `@supabase/ssr`) and still has **40** direct supabase-js call sites for orgs, invites, API tokens, audit log, scope bindings and GitHub installations | The REST contract is the seam; the supabase-js surfaces stay hosted-only |

The [BYOD drift](../byod.md) is the cautionary example: a hand-written second
copy of the schema fell 42 RPCs and a `memory_write` signature behind before
anyone noticed. Full SQLite parity would be that, at the scale of the whole
server. So this proposal does **not** port the server. It implements the REST
contract the dashboard already consumes, for one user, and holds it to the
Postgres implementation with shared contract tests.

## Proposal

```text
agent ──stdio──▶ lorekit mcp ──────────┐
CLI / hooks ───────────────────────────┼──▶ SQLite store  (~/.lorekit/lorekit.db)
dashboard ──HTTP──▶ lorekit serve ─────┘     node:sqlite, FTS5
           (REST subset of @lorekit/schemas)
```

### 1. A SQLite store behind the existing store contract

`createSqliteStore(path)` beside `createLocalStore`/`createRemoteStore`
(`packages/cli/src/store/`), implementing the same contract, so `lorekit mcp`,
the hook engine and the read commands work unchanged with `--store sqlite`.

- **Engine: `node:sqlite`**, built into Node — no npm dependency, so the CLI
  stays zero-dependency. Verified in a sandbox on Node 24.21 (SQLite 3.53.4):
  FTS5 with the `porter unicode61` tokenizer (`retry` matches `retried`) and
  JSON1 both work. It needs Node 22.13+, where the module no longer sits behind
  a flag; the CLI declares `node >=18`, so the SQLite store is opt-in and fails
  with a clear message on older Node instead of raising the floor for everyone.
- **Schema**: one `memories` table carrying the columns `@lorekit/schemas`
  responses need (scope, key, value, labels, kind, host, origin, TTL, archive,
  protection, seen/read/opened counters, timestamps), an FTS5 external-content
  table kept in sync by triggers, `usage_events`, and the read ledger the
  read-activity view aggregates.

| Postgres | SQLite |
|---|---|
| `uuid`, `timestamptz` | `TEXT` (UUID string; ISO-8601 UTC, so text order is time order) |
| `text[]` + `@>` / `&&` | JSON array + `json_each` |
| `tsvector`, `websearch_to_tsquery`, `ts_rank_cd` | FTS5 `MATCH`, `bm25()` |
| Partial unique indexes per ownership kind | Partial unique index on `(scope, key)` among active rows — one owner |
| `updated_at` and memory-cap triggers | SQLite triggers |
| `pg_cron` purges (expired, archived, old usage events) | Run in-process on start and hourly |
| RLS, `auth.uid()`, orgs | Not applicable — single local user |

`lorekit migrate --to sqlite` imports the markdown store. Markdown stays the
default offline store; SQLite is what you switch to when you want the dashboard.

### 2. `lorekit serve` — the REST subset, locally

A Node HTTP server that answers the routes the dashboard calls, with the
request and response shapes from `@lorekit/schemas`, against the SQLite store.

| Phase | Routes | Unlocks |
|---|---|---|
| Explorer | `POST /memories/list`, `GET/PATCH/DELETE /memories/:id`, `POST /memories`, `/memories/facets`, `/memories/scopes`, `/memories/activity`, `/memories/restore`, `/memories/protect` | Browse, filter, search, edit, archive |
| Insights | `/memories/usage`, `/memories/usage/runs`, `/memories/read-activity`, `/memories/read-ranking`, `/memories/utility`, `/memories/pivot`, `/memories/clusters` | Usage data |
| Later | `/memories/policies`, `/memories/groom/*`, `/memories/purge` | Grooming |

Every other route answers `501` with a stable `local_mode_unsupported` error
code that the dashboard renders as "not available in local mode".

Usage data comes from the same places as hosted: `lorekit mcp` and `serve`
record a `usage_events` row per operation, using the closed `tool_name`
vocabulary in `packages/mcp-core/src/telemetry/telemetry-vocabulary.ts`, and
bump read counters on reads — so `/insights` renders from local activity.

### 3. Dashboard local mode

- `NEXT_PUBLIC_LOREKIT_API_URL` overrides the REST base URL that `rest.ts`
  derives from `NEXT_PUBLIC_SUPABASE_URL` today.
- `LOREKIT_LOCAL_MODE=1` makes `middleware.ts` skip the Supabase session and
  use a fixed local identity, and hides the navigation entries backed by direct
  supabase-js calls (orgs, invites, API tokens, audit log, scope bindings,
  GitHub installations).
- Run it as `lorekit serve` plus the dashboard's dev server for development.
  How to ship it to self-hosters is open question 2.

### 4. Keeping two backends honest

The REST contract is the single source of truth; both backends are tested
against it. One fixture suite — seed rows, request, expected response — runs
against the Postgres handlers (the existing `memories-api.integration.spec.ts`
stack) and against `serve`. A route whose two answers disagree fails CI. That is
the mechanism that stops the BYOD-style drift; without it, this proposal
should not ship.

## Phases

1. SQLite store + `lorekit mcp --store sqlite` + `migrate --to sqlite`. Usable
   alone: agents on SQLite, no dashboard yet.
2. `lorekit serve` with the Explorer routes, dashboard local mode, the shared
   contract suite.
3. Usage events, read counters and the Insights routes.
4. Optional: grooming routes.

Each phase is its own PR, and each updates the public docs and `llms.txt`
(the repo's docs rule).

## Open questions

1. **Where `serve` lives.** The CLI is zero-dependency and cannot import
   `@lorekit/schemas` (zod). Either a new package (`@lorekit/local`) that the
   CLI delegates to when installed, or generated plain-JS validators committed
   into the CLI the way `surfaces.generated.mjs` is.
2. **How self-hosters get the dashboard.** A prebuilt Next.js standalone bundle
   inside an npm package is heavy; a container image is lighter to run but adds
   a release artifact; the dev server is fine only for contributors.
3. **Which Insights instruments are in scope.** `utility`, `pivot` and
   `clusters` are the most SQL-heavy; they could follow the core three.
4. **Teams.** SQLite is one writer on one machine. For a team self-hosting
   without Supabase Cloud, Postgres via self-hosted Supabase (Docker) keeps
   today's schema and RPCs untouched — worth evaluating separately rather than
   stretching SQLite to multi-user.
5. **Node floor.** Opt-in on Node 22.13+, or raise `engines` when the SQLite
   store becomes the offline default.
