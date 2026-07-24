# LoreKit — Agent Context

LoreKit is a Supabase-backed MCP server for shared, persistent agent memory.
Agents read and write *lore* (lessons) via MCP tool calls. A Next.js dashboard
lets humans browse, search, and manage those lessons.

→ For architecture, MCP tools, scope format, tokens, OTel, and deployment:
  **read [docs/](./docs/README.md) on demand — do NOT load all docs upfront.**

---

## Package map

| Package | Path | Role |
|---------|------|------|
| `@lorekit/core` | `packages/mcp-core/` | Scope validator, DB client, 5 tool handlers, OTel tracer/meter |
| `@lorekit/server` | `packages/mcp-server/` | Node.js HTTP server for Fly.io (OTel SDK init, auth, webhook) |
| `@lorekit/web` | `packages/web/` | Next.js 15 dashboard (Vercel) |
| `supabase` | `supabase/` | Edge Functions (production MCP server), migrations, NX targets |

The **production MCP server** is `supabase/functions/mcp/index.ts` (Deno, self-contained).
`packages/mcp-server/` is the Node.js variant for Fly.io with full OTel.

---

## NX commands

```bash
# CI gate
pnpm nx run-many -t typecheck,test,lint --all

# Individual packages
pnpm nx typecheck mcp-core
pnpm nx typecheck web
pnpm nx test mcp-core          # needs supabase start
pnpm nx serve web              # Next.js dev server

# Supabase (needs SUPABASE_PROJECT_REF in .env.local)
# NOTE: these are for local/first-time setup. Merging to main runs the
# staging-first CI/CD pipeline (.github/workflows/deploy.yml) automatically.
# See docs/deployment.md → "Automated deployment (CI/CD)".
pnpm nx deploy supabase        # typecheck + test → db push → fn:deploy
pnpm nx db:push supabase       # push migrations
pnpm nx fn:deploy supabase     # deploy mcp + health Edge Functions
pnpm nx db:types supabase      # generate TypeScript types from DB
pnpm nx health supabase        # curl /health endpoint
pnpm nx start supabase         # start local Supabase
pnpm nx fn:dev supabase        # run Edge Functions locally
```

---

## Scope format (canonical — `::` separator only)

```
global
project::{name}                           project::agent-skills
repo::{owner}/{repo}                      repo::mthines/gw-tools
branch::{owner}/{repo}::{branch}          branch::mthines/gw-tools::feat/x
```

Single `:` → 400 error. All segments lowercased. See [docs/scope-format.md](./docs/scope-format.md).

---

## Auth tiers (MCP server)

1. `SUPABASE_SERVICE_ROLE_KEY` → full access, bypasses RLS (CI only)
2. `lk_rw_*` / `lk_ro_*` API token → service-role client + **mandatory `user_id` filter** on every query
3. Supabase JWT → user-scoped client, RLS enforced automatically

**Critical:** `api_key` auth uses service-role. ALL queries must `.eq('user_id', userId)`.
Write tools require `lk_rw_*`. Read tools accept both.

---

## Limits & rate limiting

Two abuse guardrails, both free-tier defaults, config-driven, per-user
overridable (no billing built yet — see [docs/limits.md](./docs/limits.md)):

- **Memory cap** (default 1000 active memories/user) — enforced authoritatively
  by a `BEFORE INSERT` trigger on `memories` (`enforce_memory_cap()`,
  `supabase/migrations/00004_limits.sql`). Rejections are translated into an
  actionable `LimitError` (code `memory_cap`) by the app layer.
- **Rate limit** (default 120 req/min/user, all MCP methods) — a Postgres-backed
  fixed-window RPC (`lorekit_check_rate_limit()`), called by the transport layer
  right after auth resolves. Blocked requests get HTTP `429` + `Retry-After`.
- Both read their limits through `lorekit_get_limit(user_id, key)` =
  `COALESCE(user_limits override, lorekit_default_limit(key))` — no numeric
  limit is hardcoded in app code. Raising a user's limit is a `user_limits` row
  upsert (SQL) for now.
- Service-role (CI, `user_id IS NULL`) is exempt from both guardrails.

---

## Key files

| File | Purpose |
|------|---------|
| `packages/mcp-server/src/instrumentation.ts` | **First import in index.ts.** OTel SDK init. Must be `async function register()` with `NEXT_RUNTIME === 'nodejs'` guard. |
| `packages/mcp-core/src/scope.ts` | Canonical scope validation + wildcard expansion |
| `packages/mcp-core/src/telemetry.ts` | Shared tracer/meter getters, `lorekit.tool.duration` histogram |
| `packages/web/src/lib/scope.ts` | Lightweight copy of `scopeType` for Next.js bundle (no OTel deps) |
| `packages/web/src/lib/tokens.ts` | Server actions: `generateToken`, `listTokens`, `revokeToken` |
| `packages/web/src/components/providers/Dash0Provider.tsx` | Browser RUM init via `@dash0/sdk-web`. Mounted in root layout. |
| `supabase/functions/mcp/index.ts` | Self-contained Deno MCP server (production) |
| `supabase/functions/_shared/otel.ts` | Reusable OTel for Edge Functions: `traceRequest()`, `createTracedClient()` |
| `supabase/migrations/00001_memories.sql` | `memories` table, FTS, RLS |
| `supabase/migrations/00002_api_tokens.sql` | `api_tokens` table, RLS |
| `supabase/migrations/00004_limits.sql` | Memory cap trigger (`enforce_memory_cap`), rate-limit RPC (`lorekit_check_rate_limit`), `user_limits` override table, `lorekit_get_limit`/`lorekit_default_limit` config source |
| `packages/mcp-core/src/limits.ts` | `LimitError`, `translateCapError`, `checkRateLimit`, `rateLimitMessage` — mirrored self-contained in `supabase/functions/mcp/limits.ts` for the Deno edge function |

---

## OTel attributes (custom)

All `lorekit.*` spans carry:
- `lorekit.tool.name` — bounded: `memory.write|read|list|delete|search`
- `lorekit.scope` — canonical scope string
- `lorekit.scope.type` — bounded: `global|project|repo|branch`
- `lorekit.key` — lesson key
- `service.namespace` — always `lorekit`
- `deployment.environment.name` — `production|preview|development|local` (from `VERCEL_ENV`)

Metric: `lorekit.tool.duration` histogram (unit `s`) with `lorekit.tool.name` + `lorekit.scope.type`.

---

## Endpoints

| URL | Auth | Purpose |
|-----|------|---------|
| `https://<ref>.supabase.co/functions/v1/mcp` | Bearer token required | MCP server for agents |
| `https://<ref>.supabase.co/functions/v1/health` | None (public) | Uptime monitoring |
| `https://lorekit-io.vercel.app` | GitHub OAuth | Web dashboard |

---

## Key decisions (do not relitigate)

- `::` separator avoids collision with `/` in repo paths and `:` in branch names
- `lk_rw_` prefix encodes permission visibly in config files
- Token SHA-256 hash in DB — shown once, never stored in plain text
- `AlwaysOn` OTel sampler — sampling deferred to Dash0 pipeline, never SDK-side
- `instrumentation.ts` must be `async function register()` with `NEXT_RUNTIME === 'nodejs'` guard
- `Dash0Provider` React component is the primary RUM init path (explicit, visible in component tree)
- Edge Function is self-contained Deno (no cross-package imports) — Node.js MCP SDK incompatible with Deno
- NX 22.4.0 — matches `gw-tools` exactly; bump both together
- Memory cap enforced by a DB trigger (not app-side counting) — the write-path `userId` is auth-type-sensitive (null for JWT users, RLS-scoped), so only a `NEW.user_id`-keyed trigger is auth-agnostic and unbypassable
- Rate limiting is a Postgres-backed fixed-window counter (not in-memory or Redis) — edge isolates are stateless/short-lived; no new infra required
- Limits config lives in one DB function (`lorekit_default_limit`) + one override table (`user_limits`) — no numeric limit hardcoded in app code, so raising a user's ceiling is a single row upsert (paid-tier-ready, no billing built now)
- CI/CD is split: `ci.yml` **verifies before merge** (PRs + non-main branches) — `check` runs mocked unit tests, `integration` boots a local Supabase and runs the live `smoke.integration` spec (the web build is covered by Vercel's own PR check, not CI). `deploy.yml` owns `main` and **deploys the already-verified commit** (no test re-run) as a **staging-first promotion pipeline** (deploy-staging → smoke-staging → deploy-production → smoke-production → rollback-on-failure). Tests run once, on the PR; the deploy path only smoke-tests the live deployment. Make `check` + `integration` required status checks — they are the sole gate keeping unverified code off main. Two Supabase projects, secrets scoped via `staging`/`production` GitHub Environments. Migrations are forward-only (expand/contract + PITR); only Edge Functions auto-rollback. `[functions.*] verify_jwt = false` in config.toml mirrors the deploy `--no-verify-jwt` flag and lets `supabase start` serve functions for the integration test. Do not re-merge the workflows or re-add a deploy-time test job — the split is what removed the old double test + double `db push`. See docs/deployment.md.
