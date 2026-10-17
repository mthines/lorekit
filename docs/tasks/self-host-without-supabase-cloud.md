# Proposal: self-host LoreKit without Supabase Cloud — one Docker bundle for one person or a team

> Status: **proposal / not started** · Area: deployment, web, CLI · Size: **M–L** (phased)
> Replaces this PR's earlier "local mode on SQLite" draft. It rests on three
> maintainer decisions: teams must be supported; anything big stays out of the
> CLI; the distribution should be the easiest and most flexible one.

## Problem

Seeing the dashboard and usage data today requires Supabase Cloud — the hosted
instance, or your own Supabase and Vercel projects ([install.md](../install.md)).
The offline markdown store needs no account but has no dashboard, and BYOD
([byod.md](../byod.md)) moves only memory rows. The goal: the dashboard and
usage data on infrastructure you run, with no Supabase account, for one person
on a laptop or a team on a server.

## Decision 1 — Postgres, not SQLite

Team features are implemented in Postgres, not TypeScript:

| Fact (measured on `main` at 00113) | Consequence |
|---|---|
| 108 migrations define 87 SQL functions; the edge functions make string-literal `.rpc('…')` calls to 48 of them, the org, invite, token and retention RPCs among them | A SQLite backend re-implements each one a route needs |
| The Explorer's RPCs alone are ~1,200 lines of PL/pgSQL, Insights ~690 more | That is the size of the second implementation before any team feature |
| `lorekit_memory_list`, `_facets`, `_activity` and `_pivot` were all redefined in the newest migration | A second implementation drifts at that rate |
| Org visibility is one `SECURITY DEFINER` predicate (`lorekit_member_org_ids`) shared by RLS and the edge | Porting it means porting RLS semantics too |

BYOD's hand-written copy of the schema is what that drift looks like: it fell
42 RPCs and a `memory_write` signature behind before anyone noticed. Postgres
keeps one implementation for hosted, self-hosted, team and solo use.

## Decision 2 — Run Supabase's open-source services, not Supabase Cloud

LoreKit's server side is four open-source components, each published as a
Docker image: Postgres (`supabase/postgres`, which ships pg_cron, pgvector and
pg_trgm), Auth (GoTrue), PostgREST, and Edge Functions (`supabase/edge-runtime`,
Deno). Kong routes `/auth/v1`, `/rest/v1` and `/functions/v1` on one origin, the
shape the dashboard (`rest.ts` derives `${url}/functions/v1`) and the CLI
already expect. The server code does not change, and the migrations apply the
way they do in CI.

Supabase's full self-host stack adds Studio, Realtime, Storage, imgproxy and
analytics; LoreKit uses none of them, so the bundle leaves them out.

## Decision 3 — Distribution: one compose bundle, scaffolded by the CLI

| Option | Footprint | Teams | Verdict |
|---|---|---|---|
| **Compose bundle with prebuilt images** (GHCR) | Images pulled on first run; CLI unchanged except a small scaffold command | Yes | **Recommended** |
| Everything in one npm package | Needs the GoTrue, PostgREST and Deno binaries; the dashboard alone is a Next.js server | Yes | Not practical without containers |
| SQLite server inside the CLI | ~+100 KB on a 385 KB package; 0 ms startup cost if loaded only by its command | No | Single user only, and a second implementation |
| PGlite (Postgres in WASM) server | 34 MB unpacked — about 28× the CLI, so a separate package | No | Reuses the SQL, but PostgREST and the handlers would still need a port |

Measured for the CLI-size question: `@lorekit/cli` is 385 KB packed, 1.2 MB
unpacked, and starts in ~130 ms (bare Node: ~45 ms) because `commands.mjs`
imports all 27 commands eagerly. `node:sqlite` is built into Node and costs
nothing to load. Under the recommended plan nothing big enters the CLI.

The CLI's part is scaffolding:

- `lorekit selfhost init [dir]` writes `compose.yaml` and a `.env` with
  generated secrets (JWT secret, anon and service keys, Postgres password) — a
  template plus a short command.
- `lorekit install --endpoint http://<host>:8000/functions/v1/mcp` already
  points agents at the result; `LOREKIT_APP_URL` already points deep links at
  a self-hosted dashboard.

## The bundle

| Service | Image | Job |
|---|---|---|
| `db` | `supabase/postgres` | Data, in a volume |
| `migrate` | LoreKit image | One-shot: applies `supabase/migrations/` on first run and on upgrade |
| `auth` | `supabase/gotrue` | Email + password (auto-confirm, so no SMTP needed); GitHub OAuth optional |
| `rest` | `postgrest/postgrest` | PostgREST, which the edge functions and dashboard call |
| `functions` | LoreKit image on `supabase/edge-runtime` | `mcp`, `memories`, `orgs`, … with their `npm:` dependencies pre-cached |
| `kong` | `kong` | One origin (`:8000`) for auth, rest and functions |
| `web` | LoreKit image | The dashboard, a Next.js standalone build |

- **One person:** `lorekit selfhost init && docker compose up -d` on a laptop.
- **A team:** the same on a VM behind TLS, with `SITE_URL` and `API_URL` set;
  teammates sign up and are invited through the existing org feature.
- **Upgrades:** pull the new images; `migrate` applies new migrations.
- **Backups:** `pg_dump` of the `db` volume.

## Work items the proof of concept must settle

1. **Dashboard runtime config.** `NEXT_PUBLIC_SUPABASE_URL` (17 reads) and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` are inlined at build time, so a prebuilt
   image is tied to one backend. Serve them as runtime config through
   `lib/supabase/config.ts`, already the single resolver, and add
   `output: 'standalone'` to `next.config.ts`.
2. **Edge functions offline.** Their `npm:` imports resolve when the function
   boots; bake a Deno cache into the image, and confirm `EdgeRuntime.waitUntil`
   (used for token touch-ups and telemetry flushes) behaves under edge-runtime.
3. **Vercel assumptions.** `NEXT_PUBLIC_VERCEL_ENV` (13 reads) feeds the
   deployment environment; self-host needs an explicit override, as the edge
   already has.
4. **Optional telemetry.** With no Dash0 endpoint configured, exporters stay off.
5. **CI.** A job that boots the bundle and runs `packages/smoke-tests` against
   it. Adding it needs a workflow edit by a maintainer.

## Phases

1. Compose bundle built from source; the smoke tests pass against it.
2. Runtime config, images on GHCR, `lorekit selfhost init`, and an install.md
   Docker path (README "Run your own instance" too).
3. External managed Postgres and a Helm chart, if asked for.

A Docker-free single-user mode (SQLite in the CLI, loaded only by its command)
stays possible later; it is not needed for this goal.

## Relationship to BYOD

BYOD remains the option for keeping memory rows in a separate Supabase project
while using a LoreKit `mcp` function — MCP tools only. The bundle is the path
for running the dashboard and usage views on your own infrastructure.

## Open questions

1. **Supabase software, no Supabase account — acceptable?** If the goal is no
   Supabase components at all, the alternative is a LoreKit Node server on
   plain Postgres that reuses the SQL but replaces GoTrue, PostgREST and the
   edge runtime: weeks, not days.
2. **Registry.** GHCR under `mthines/lorekit`?
3. **Default sign-in.** Email + password only, or GitHub OAuth required?
