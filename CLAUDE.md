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
| `@lorekit/cli` | `packages/cli/` | Zero-dep Node CLI: `install` (scaffolds the `lorekit-memory` skill, MCP server, and the deterministic lifecycle hooks into `.claude`/`~/.claude` per a project/global prompt — the plugin's three parts without a marketplace; `--no-hooks` to skip), `doctor` (connectivity/token/scope health checks), `hook` (the shared hook engine behind the plugins), and `mcp` (a hand-rolled local stdio MCP server exposing `memory.*` from the resolved store — lets `.mcp.json` point at the CLI instead of `mcp-remote`, for offline local-mode tool calls). Ships the skill under `skill/lorekit-memory/`. Verified by its own `node:test` suite; excluded from the NX TS lint gate. |
| `plugins/` | `plugins/` | Per-framework deterministic bundles: `lorekit-claude` (marketplace plugin: skill + hooks + MCP), `lorekit-cursor` (rule + `stop` hook), `lorekit-codex` (feature-flagged hooks + `AGENTS.md` fallback, experimental). Root `.claude-plugin/marketplace.json` lists the Claude plugin. |
| `supabase` | `supabase/` | Edge Functions (production MCP server), migrations, NX targets |

The **production MCP server** is `supabase/functions/mcp/index.ts` (Deno, self-contained).
`packages/mcp-server/` is the Node.js variant for Fly.io with full OTel.

**Shared hook engine:** `lorekit hook --adapter <claude|cursor|codex> --event <name>` reads the host's
JSON on stdin and injects lessons / a retrospective nudge on stdout, always exiting 0. Logic lives once
in `packages/cli/src/{core,adapters}/`; each adapter reshapes I/O to its host. The Claude plugin's skill
copy is vendored from `packages/cli/skill/` — keep in sync via `node scripts/sync-plugin-skill.mjs` (a
`--check` mode guards drift).

**Cross-framework validation:** `packages/cli/test/frameworks.test.mjs` replays payload fixtures
(`test/fixtures/<adapter>-<event>.json`) through the binary and asserts each host's output contract, runs
`claude plugin validate` (skips if the CLI is absent), and structurally checks the Cursor/Codex configs.
Harvest real fixtures with `LOREKIT_HOOK_RECORD=<dir>` set on the hook command (one run per framework).

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
2. `lk_rw_*` / `lk_ro_*` / `lk_wo_*` API token → service-role client + **mandatory `user_id` filter** on every query
3. Supabase JWT → user-scoped client, RLS enforced automatically

**Critical:** `api_key` auth uses service-role. ALL queries must `.eq('user_id', userId)`.
Write tools require write permission (`lk_rw_*` / `lk_wo_*`); read tools require read
permission (`lk_rw_*` / `lk_ro_*`). `lk_ro_*` is denied on write tools; `lk_wo_*` is denied
on read tools — both with the standard `-32001` permission-denied error. The gating logic
(`READ_TOOLS`/`WRITE_TOOLS`/`toolRequires`/`tokenPrefixFor`) is a shared pure module,
`packages/mcp-core/src/permissions.ts`, mirrored self-contained into
`supabase/functions/mcp/permissions.ts` (the `limits.ts` pattern) — the Node.js
`mcp-server` has no API-token auth path today and is out of scope for this gating.

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
| `packages/mcp-core/src/permissions.ts` | `READ_TOOLS`/`WRITE_TOOLS`, `toolRequires`, `tokenPrefixFor` — the `lk_rw_`/`lk_ro_`/`lk_wo_` prefix derivation and read/write tool-gating switch. Mirrored self-contained in `supabase/functions/mcp/permissions.ts` (edge) and lightly in `packages/web/src/lib/token-permission.ts` (web, `permissionSuffix`/`tierFor`/`PERMISSION_TIERS`) — the `limits.ts` pattern |
| `supabase/migrations/00008_webhook_secrets_repo.sql` | Adds nullable `repo` column (`owner/name`, CHECK-constrained) to `webhook_secrets`; partial unique index `(user_id, coalesce(repo,'')) where active` — one active secret per `(user, repo)` |
| `packages/mcp-core/src/webhook-secret-select.ts` | Pure `selectWebhookSecrets` — matches active rows by `repository.full_name`, falls back to a legacy null-`repo` row, then `GITHUB_WEBHOOK_SECRET` — mirrored self-contained in `supabase/functions/mcp/webhook-secret-select.ts` for the Deno edge function |
| `supabase/migrations/00009_memory_write_created_at.sql` | Drops + recreates the `memory_write` RPC with an optional `p_created_at timestamptz default null`; INSERT uses `coalesce(p_created_at, now())` for both `created_at` and `updated_at` (conflict-update never touches `created_at`). Lets `memory.write` backdate a migrated memory. No table change — `created_at` already existed |
| `packages/mcp-core/src/created-at.ts` | Pure `parseCreatedAt` — validates the optional `memory.write` `created_at` override, normalises to ISO, rejects invalid + future dates (60s skew). Mirrored self-contained in `supabase/functions/mcp/created-at.ts` (edge) and `packages/cli/src/store/created-at.mjs` (zero-dep CLI) — the `limits.ts` pattern |
| `supabase/functions/mcp/webhook.ts` | GitHub webhook handler; `resolveSecrets()` queries `webhook_secrets` by `full_name` (no `auth.users`/`listUsers` join) |
| `packages/web/src/lib/webhook-secrets.ts` | Server actions: `listWebhookSecrets`, `generateWebhookSecret(repo)` — per-repo, Supabase-JWT + RLS scoped (not an `lk_rw_*` API token path) |
| `packages/web/src/lib/repo-format.ts` | Pure `normalizeRepo` — validates/lowercases a bare `owner/name` repo identifier |
| `supabase/migrations/00010_audit_log.sql` | `audit_log` table (bounded `action` CHECK over 11 actions), append-only RLS (SELECT + scoped INSERT only, no update/delete), `(user_id, created_at desc)` + `(action)` indexes, and the `audit_user_limits()` trigger (the D2 exception — see Key decisions) |
| `supabase/migrations/00011_memory_write_inserted.sql` | Drop + recreate `memory_write` adding an additive `inserted boolean` (`RETURNING (xmax = 0) AS inserted`) so callers can discriminate `memory.create` vs `memory.update` for the audit log |
| `packages/mcp-core/src/audit.ts` | `AUDIT_ACTIONS`/`AuditAction`, pure `buildAuditEntry`, non-throwing `recordAudit` — mirrored self-contained in `supabase/functions/mcp/audit.ts` for the Deno edge function |
| `packages/web/src/lib/audit-log.ts` | Server actions: `recordAuditEvent` (non-throwing writer), `listAuditLog(filters)` (RLS-scoped, keyset-paginated reader returning `{ rows, nextCursor, hasMore }`) — powers Settings → Audit Logs |
| `packages/web/src/lib/audit-actions.ts` | `AuditAction` union (re-declared, no `@lorekit/core` dependency in `web`) + `AUDIT_ACTION_META` single-record badge metadata |
| `packages/web/src/lib/pagination/` | Pure, audit-decoupled keyset-pagination + filter module: `cursor.ts` (opaque base64url cursor codec, fails closed to `null` on any malformed/forged input — safe because callers still apply their own `user_id` scoping), `keyset.ts` (`clampPageSize`, the `(created_at desc, id desc)` `.or()` predicate, fetch+1 → page assembly), `filters.ts` (`normalizeActions` against a caller-supplied allow-set, LIKE/PostgREST-escaping `substringNeedle`, inclusive-`from`/half-open-`to` `dateRangeBounds`), `apply.ts` (thin supabase-js query-builder shell). Each pure file has a co-located `.spec.ts` (mirrors `aggregations.spec.ts`/`repo-format.spec.ts`); composed by `listAuditLog` in `audit-log.ts`, the only current consumer |
| `packages/web/src/lib/queries/audit-log.ts` | `useAuditLog` — `useInfiniteQuery` over the `listAuditLog` server action, keyed by the URL-backed filter state (action set / name / date range); drives the feed's "Load more" |
| `supabase/migrations/00012_audit_log_search.sql` | Enables `pg_trgm` + a GIN trigram index on `audit_log.target` (index-backed `ilike` name search) and a `(user_id, created_at desc, id)` index covering the keyset seek (00010's `(user_id, created_at desc)` index lacks the `id` tiebreaker) |

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
- Write-only tokens (`lk_wo_*`) store `permissions: ['write']` in the existing `text[]` column — zero migration. Prefix derivation and tool gating (`READ_TOOLS`/`WRITE_TOOLS`/`toolRequires`/`tokenPrefixFor`) are consolidated into a shared pure module (`packages/mcp-core/src/permissions.ts`), mirrored self-contained into the edge function and lightly into web — the same reasoning as `limits.ts`/`webhook-secret-select.ts`: the edge function has no test harness, so the pure module is the only unit-testable home for gating logic. The Node.js `mcp-server` gets no gating — it has no API-token auth path at all, and adding one is out of scope.
- Token SHA-256 hash in DB — shown once, never stored in plain text
- `AlwaysOn` OTel sampler — sampling deferred to Dash0 pipeline, never SDK-side
- `instrumentation.ts` must be `async function register()` with `NEXT_RUNTIME === 'nodejs'` guard
- `Dash0Provider` React component is the primary RUM init path (explicit, visible in component tree)
- Edge Function is self-contained Deno (no cross-package imports) — Node.js MCP SDK incompatible with Deno
- NX 22.4.0 — matches `gw-tools` exactly; bump both together
- Memory cap enforced by a DB trigger (not app-side counting) — the write-path `userId` is auth-type-sensitive (null for JWT users, RLS-scoped), so only a `NEW.user_id`-keyed trigger is auth-agnostic and unbypassable
- Rate limiting is a Postgres-backed fixed-window counter (not in-memory or Redis) — edge isolates are stateless/short-lived; no new infra required
- Limits config lives in one DB function (`lorekit_default_limit`) + one override table (`user_limits`) — no numeric limit hardcoded in app code, so raising a user's ceiling is a single row upsert (paid-tier-ready, no billing built now)
- Webhook secrets are **repo-scoped**, matched by the delivery's `repository.full_name` against a stored `repo` column (`webhook_secrets.repo`, nullable) — not by joining `repository.owner.login` against `auth.users` (that join is O(all users), capped at 1000, and fails for org-owned repos where the owner login is the org, not any user's personal GitHub login). A null-`repo` row is a legacy/global fallback kept for back-compat; `GITHUB_WEBHOOK_SECRET` remains the last-resort env-var fallback. The selection logic (`selectWebhookSecrets`) is pure and lives in `packages/mcp-core` (vitest-tested, no Deno test harness exists), mirrored self-contained into the edge function — the same pattern as `limits.ts`. Webhook server actions authenticate via the Supabase user JWT + RLS, not an `lk_rw_*` API token — the `lk_rw_*` rule is for MCP `api_key` tool calls, not dashboard server actions.
- Audit logging (`audit_log` table, `supabase/migrations/00010_audit_log.sql`) is captured **at the app layer** — an explicit `recordAudit`/`recordAuditEvent` call right after each sensitive mutation succeeds (API-key create/revoke, webhook-secret create/rotate, memory create/update/archive/restore/delete), not by DB triggers on the underlying tables — the app layer can resolve the actor (`auth.uid()` for dashboard actions, the resolved token/user for MCP, `null` for service-role/CI) and shape a human-readable `target`/`metadata` that a trigger on `memories`/`api_tokens`/`webhook_secrets` cannot. **The one deliberate exception is `user_limits`**: no app-layer code path writes that table today (raising a limit is a raw SQL upsert), so there's no call site to instrument — an `AFTER INSERT OR UPDATE OR DELETE` DB trigger (`audit_user_limits()`) is the only way to capture `limit.override` events, mirroring the `enforce_memory_cap()` DB-trigger precedent for the same reason (the write-path actor isn't app-visible there either). `recordAudit`/`recordAuditEvent` never throw — a failed audit write must never break the primary operation it's auditing. Mirrored self-contained into `supabase/functions/mcp/audit.ts` for the Deno edge function, the same pattern as `limits.ts`/`created-at.ts`.
- Audit Logs pagination is **keyset (cursor), not OFFSET** — `listAuditLog` orders `(created_at desc, id desc)` and pages via an opaque `nextCursor` (base64url `{ c, id }`, `packages/web/src/lib/pagination/cursor.ts`). The cursor carries no `user_id`; `listAuditLog` applies its own `.eq('user_id', …)` unconditionally, so a forged/tampered cursor can at worst mis-page the caller's own rows, never widen visibility — that's what makes `decodeCursor` safe to fail closed to `null` (→ first page) without HMAC/signing. Name search (`target ilike '%…%'`) is index-backed by a `pg_trgm` GIN trigram index (`supabase/migrations/00012_audit_log_search.sql`); the keyset seek is covered by `(user_id, created_at desc, id)` (00010's `(user_id, created_at desc)` index lacks the `id` tiebreaker). The pure pagination/filter logic lives in `packages/web/src/lib/pagination/`, decoupled from audit so it's reusable by any future `(timestamp, id)`-ordered list.
- The Audit Logs actor (avatar + name) is resolved **at read time** from the authenticated session user (`full_name`/`email` + `avatar_url`, via the pure `resolveAuditActor` in `packages/web/src/lib/audit-actor.ts`) — RLS (`user_id = auth.uid()`) guarantees every visible row belongs to the session user, so one session-derived actor applies to every row with zero new query. **No PII is stored in `audit_log`** and no migration was added; cross-user/team actor resolution (a `public.profiles` view or similar) is explicitly deferred.
- CI/CD is split: `ci.yml` **verifies before merge** (PRs + non-main branches) — `check` runs mocked unit tests, `integration` boots a local Supabase and asserts the stack wires up (migrations apply, functions serve, authenticated MCP `tools/list` → 200) **and** runs `supabase/tests/migrations.test.sql` directly on Postgres — plpgsql `ASSERT`s over the SQL-only business rules (memory-cap + rate-limit triggers/RPCs, RLS user isolation, `memory_write` created_at insert-vs-conflict semantics, webhook-secret partial-unique + repo CHECK) that the mocked unit tests can only assume; the full CRUD `smoke.integration` round-trip runs in `smoke-staging` against a real project, not locally — the local edge runtime's older PostgREST can't resolve the `UNIQUE NULLS NOT DISTINCT` upsert arbiter for service-role writes. The web build is covered by Vercel's own PR check, not CI. `deploy.yml` owns `main` and **deploys the already-verified commit** (no test re-run) as a **preview-first promotion pipeline** (deploy-preview → smoke-preview → deploy-production → smoke-production → rollback-on-failure; the pre-prod GitHub Environment is named `preview`). Tests run once, on the PR; the deploy path only smoke-tests the live deployment. Make `check` + `integration` required status checks — they are the sole gate keeping unverified code off main. Two Supabase projects, secrets scoped via `preview`/`production` GitHub Environments. Migrations are forward-only (expand/contract + PITR); only Edge Functions auto-rollback. `[functions.*] verify_jwt = false` in config.toml mirrors the deploy `--no-verify-jwt` flag and lets `supabase start` serve functions for the integration test. Do not re-merge the workflows or re-add a deploy-time test job — the split is what removed the old double test + double `db push`. See docs/deployment.md.
