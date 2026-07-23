# LoreKit — Setup Guide

This document covers everything that was scaffolded for you and everything you need to do yourself to get LoreKit running end-to-end.

---

## What has already been done

### Code (46 files, ~3 000 lines)

| Area | Files | What they do |
| ---- | ----- | ------------ |
| **NX workspace** | `nx.json`, `package.json`, `tsconfig.base.json`, `vitest.workspace.ts`, `pnpm-workspace.yaml`, `eslint.config.mjs` | Monorepo config matching `gw-tools` exactly — same NX 22.4.0, same plugin set, same pnpm version |
| **`@lorekit/core`** | `packages/mcp-core/src/scope.ts` | Parses and validates canonical scope strings (`global`, `project::name`, `repo::owner/repo`, `branch::owner/repo::branch`). Rejects invalid separators with a clear error. |
| | `packages/mcp-core/src/db.ts` | Thin wrappers around `@supabase/supabase-js` — `createUserClient(jwt)` and `createServiceClient(serviceKey)` |
| | `packages/mcp-core/src/tools/write.ts` | `memory.write` handler — upserts a lesson, emits `lorekit.memory.write` OTel span |
| | `packages/mcp-core/src/tools/read.ts` | `memory.read` handler |
| | `packages/mcp-core/src/tools/list.ts` | `memory.list` handler — supports tag filtering |
| | `packages/mcp-core/src/tools/delete.ts` | `memory.delete` handler |
| | `packages/mcp-core/src/tools/search.ts` | `memory.search` handler — Postgres full-text search via `to_tsvector`; supports `repo::owner/*` wildcard |
| | `packages/mcp-core/src/telemetry.ts` | Shared tracer/meter getters; `lorekit.tool.duration` histogram definition |
| | `packages/mcp-core/src/scope.spec.ts` | Unit tests for scope validation and wildcard expansion |
| **`@lorekit/server`** | `packages/mcp-server/src/instrumentation.ts` | **OTel SDK init** — must be first import. Configures OTLP HTTP/protobuf exporter to Dash0, auto-instrumentation for HTTP + Postgres + Node.js runtime, `forceFlushAll` on crash |
| | `packages/mcp-server/src/logger.ts` | pino structured logger — injects `trace_id` and `span_id` from the active OTel span into every log record |
| | `packages/mcp-server/src/auth.ts` | Auth middleware — validates Supabase JWTs via `supabase.auth.getUser()`; detects service-role token for CI; returns JSON-RPC `-32001` on failure |
| | `packages/mcp-server/src/server.ts` | MCP server — registers all five tools via `@modelcontextprotocol/sdk`; uses `StreamableHTTPServerTransport` |
| | `packages/mcp-server/src/webhooks/github.ts` | GitHub webhook handler — HMAC-verifies `x-hub-signature-256`; creates candidate memory entries from `pull_request_review_comment` and `pull_request_review` events |
| | `packages/mcp-server/src/index.ts` | HTTP entry point — routes `/mcp`, `/webhooks/github`, `/healthz` |
| | `packages/mcp-server/src/auth.spec.ts` | Auth middleware tests (valid JWT, service-role, unauthenticated) |
| | `packages/mcp-server/src/webhooks/github.spec.ts` | Webhook tests with fixture payloads + HMAC signing |
| **Database** | `supabase/migrations/00001_memories.sql` | `memories` table with FTS column, scope + FTS indexes, full RLS policies (owner read/write + org sharing), `updated_at` trigger |
| **Edge Function** | `supabase/functions/mcp/index.ts` | Thin Deno wrapper — routes requests to the same auth + server handlers |
| **CI** | `.github/workflows/ci.yml` | NX typecheck + test + lint on every push; Supabase `db push` migration on merge to `main` |
| **Plan** | `.agent/feat/initial-plan/plan.v3.md` | Full implementation plan (14 acceptance criteria) |
| | `.agent/feat/initial-plan/checks.yaml` | Executable acceptance checks for the `aw` executor |

### OTel telemetry wired up

Every MCP tool call produces:

- A **trace** in Dash0 with span name `lorekit.memory.{write|read|list|delete|search}`, attributes `lorekit.scope`, `lorekit.scope.type`, `lorekit.key`, `lorekit.tool.name`, `lorekit.result.count`
- A data point on the **`lorekit.tool.duration` histogram** (unit: seconds) with `lorekit.tool.name` + `lorekit.scope.type` — gives you RED metrics per tool out of the box
- **Log records** with `trace_id` + `span_id` for log-trace correlation in Dash0 Logs Explorer
- HTTP + Postgres spans from auto-instrumentation (no extra config needed)

---

## What you need to do

Work through these steps in order. Each section is independent of the others except where noted.

---

### Step 1 — Grant the Dash0 GitHub App access to this repo

**Why:** The Dash0 GitHub integration can only push to repos it has been granted access to. The code is committed locally but can't be pushed until this step is done.

1. Go to [github.com/settings/installations](https://github.com/settings/installations)
2. Find **dash0** in the list → click **Configure**
3. Under "Repository access", add **`mthines/lorekit`**
4. Save

Once done, come back to the Agent0 thread and say "push it" — the PR will be opened within seconds.

---

### Step 2 — Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Name it `lorekit` (or anything — it's just a label)
3. Choose a region close to you
4. Save the generated **Project URL**, **anon key**, and **service role key** — you'll need all three

---

### Step 3 — Enable GitHub OAuth in Supabase

This lets human developers log in to LoreKit with their GitHub account to get a scoped JWT.

1. In the Supabase dashboard: **Authentication → Providers → GitHub**
2. Toggle **Enable GitHub provider**
3. Create a GitHub OAuth App at [github.com/settings/developers](https://github.com/settings/developers):
   - Application name: `LoreKit`
   - Homepage URL: `https://<your-project-ref>.supabase.co`
   - Authorization callback URL: `https://<your-project-ref>.supabase.co/auth/v1/callback`
4. Copy the **Client ID** and **Client Secret** back into the Supabase GitHub provider form

---

### Step 4 — Apply the database migration

```bash
# Install Supabase CLI if needed
npm install -g supabase

# Link to your project
supabase link --project-ref <your-project-ref>

# Apply the migration
supabase db push
```

This creates the `memories` table with full-text search, scope indexes, and RLS policies.

To verify it worked:
```bash
supabase db psql --project-ref <your-project-ref> -c "\d memories"
```

---

### Step 5 — Configure environment variables

Copy `.env.example` to `.env.local` and fill in all values:

```bash
cp .env.example .env.local
```

```bash
# ── Supabase ──────────────────────────────────────────────────────────────────
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<from Supabase dashboard → Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<from Supabase dashboard → Settings → API>

# ── GitHub Webhook ─────────────────────────────────────────────────────────────
GITHUB_WEBHOOK_SECRET=<generate: openssl rand -hex 32>

# ── OpenTelemetry → Dash0 ─────────────────────────────────────────────────────
# Endpoint: https://app.dash0.com/settings/endpoints → copy the OTLP endpoint
# Token:    https://app.dash0.com/settings/auth-tokens → Create Token
OTEL_SERVICE_NAME=lorekit
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.us-east-1.aws.dash0.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <your-dash0-token>
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register

# ── Server ────────────────────────────────────────────────────────────────────
PORT=3000
LOG_LEVEL=info
```

> **Local dev without Dash0:** Replace the OTEL lines with `OTEL_TRACES_EXPORTER=console OTEL_METRICS_EXPORTER=console` to see spans in your terminal instead.

---

### Step 6 — Install dependencies and run locally

```bash
pnpm install
pnpm nx dev mcp-server    # single run
# or
pnpm nx serve mcp-server  # with --watch
```

Verify it's running:
```bash
curl http://localhost:3000/healthz
# → ok
```

---

### Step 7 — Add CI secrets to GitHub

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
| ----------- | ----- |
| `SUPABASE_PROJECT_REF` | Your project ref (the subdomain in your Supabase URL) |
| `SUPABASE_ACCESS_TOKEN` | From [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) |

These are only used for the `supabase db push` step that runs on merge to `main`. The typecheck/test/lint job doesn't need them.

---

### Step 8 — Set up the GitHub webhook

For LoreKit to automatically create memory entries from PR review comments:

1. In any GitHub repo you want it to learn from: **Settings → Webhooks → Add webhook**
2. **Payload URL:** `https://<your-lorekit-url>/webhooks/github`
3. **Content type:** `application/json`
4. **Secret:** the value of `GITHUB_WEBHOOK_SECRET` from your `.env.local`
5. **Which events?** Select individual: `Pull request review comments` + `Pull request reviews`
6. Save

---

### Step 9 — Deploy

**Option A — Supabase Edge Functions (simplest):**
```bash
supabase functions deploy mcp --project-ref <your-project-ref>
```
> Note: OTel telemetry to Dash0 is **not available** in the Edge Function deployment — the Node.js OTel SDK doesn't run in Deno. You'll see spans from local runs but not from the Edge Function. For full observability, use Option B.

**Option B — Fly.io (recommended for full OTel):**
```bash
fly launch           # follow prompts, choose a small instance (256MB RAM is enough)
fly secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... # etc, all vars from Step 5
fly deploy
```
The Node.js OTel SDK runs normally here and all traces/metrics/logs will appear in Dash0.

---

### Step 10 — Point `persistent-memory` at LoreKit

In any project using the `persistent-memory` skill, add to your `.claude/skills/persistent-memory/config.json` (or equivalent config file for your agent client):

```json
{
  "backend": "mcp",
  "mcp": {
    "server": "https://<your-lorekit-url>",
    "auth": {
      "type": "bearer",
      "token": "<your-supabase-jwt>"
    }
  }
}
```

To get a Supabase JWT for your user, authenticate via GitHub OAuth once and copy the token from the session.

---

## Summary checklist

```
[ ] Step 1 — Grant Dash0 GitHub App access to mthines/lorekit
[ ] Step 2 — Create Supabase project, note URL + anon key + service role key
[ ] Step 3 — Enable GitHub OAuth in Supabase Auth
[ ] Step 4 — supabase db push (applies migration)
[ ] Step 5 — Fill in .env.local (Supabase + Dash0 + webhook secret)
[ ] Step 6 — pnpm install && pnpm nx dev mcp-server (verify /healthz)
[ ] Step 7 — Add SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN to GitHub secrets
[ ] Step 8 — Add GitHub webhook to repos you want LoreKit to learn from
[ ] Step 9 — Deploy (Supabase Edge Functions for simplicity, Fly.io for full OTel)
[ ] Step 10 — Point persistent-memory skill at your LoreKit deployment
```

---

## What's left to build (not in this scaffold)

These are the novel USPs from the planning session that were intentionally out of scope for v1 but are designed for:

| Feature | Plan note |
| ------- | --------- |
| **Confidence scoring + decay** | Add `confidence float` + `last_confirmed_at` columns; `memory.confirm` MCP tool; Supabase scheduled function for weekly decay |
| **Agent attribution provenance** | `source_agent` + `trigger` columns are already in the schema — surface them in `memory.list` output |
| **Branch → Repo → Global auto-promotion** | Supabase trigger on `seen_count >= 3`; externalises the `aw-lessons` promotion mechanic |
| **PR lesson diff comment** | Extend webhook handler: on `pull_request closed+merged`, diff branch scope vs repo scope, post a PR comment via GitHub API |
| **`lore export` CLI** | New `packages/lore-cli` NX package; `lore export --scope repo::mthines/gw-tools --top 10` renders lessons as Markdown for `CLAUDE.md` injection |
