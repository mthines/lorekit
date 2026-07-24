# Deployment

LoreKit has three deployable pieces. Each has its own deployment path.

## Overview

| Piece | Platform | Deploy command |
|-------|----------|----------------|
| MCP server + health check | Supabase Edge Functions | `pnpm nx fn:deploy supabase` |
| Web dashboard | Vercel | Auto-deploy on `git push main` |
| Database migrations | Supabase | `pnpm nx db:push supabase` |

**In normal operation you do not run these by hand.** Merging to `main` triggers
the [automated CI/CD pipeline](#automated-deployment-cicd), which promotes
migrations + Edge Functions **staging → production** with smoke gates and
automatic function rollback. The manual commands below are for first-time
project setup and local operations.

---

## Automated deployment (CI/CD)

Two GitHub Actions workflows own the lifecycle:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `.github/workflows/ci.yml` | PRs to `main`, pushes to non-`main` branches | **Verify before merge.** `check` (affected typecheck/test/lint — unit tests, all mocked), `integration` (boots a local Supabase, serves the real Edge Functions, runs the live `smoke.integration` spec + schema lint), and `build-web`. |
| `.github/workflows/deploy.yml` | push to `main`, `workflow_dispatch` | **Deploy the already-verified commit.** No test re-run — staging-first promotion only. |

### Tests run once, on the PR

Unit and integration tests run in `ci.yml` on every PR (and feature-branch
push), so a commit cannot reach `main` unverified. The deploy pipeline
deliberately does **not** re-run them — it trusts the required PR checks and
only verifies the *live deployment* via smoke tests. Make the `check` and
`integration` jobs [required status checks](#recommended-branch-protection) so
this guarantee holds.

The `integration` job is the pre-merge equivalent of `smoke-staging`: it runs
the exact same `smoke.integration` spec, against a local Supabase instead of the
staging project.

### The deploy pipeline (on merge to `main`)

Each job `needs:` the previous one, so a red step is a hard gate — nothing
downstream runs:

```
deploy-staging          db push + functions deploy → STAGING project
  └─▶ smoke-staging      smoke.integration spec against STAGING
        └─▶ deploy-production     db push + functions deploy → PRODUCTION project
              └─▶ smoke-production   health + MCP tools/list against PRODUCTION
                    └─▶ rollback-production   (only on failure)
```

Production is never touched until staging has been deployed and smoke-tested.

### Rollback behaviour

On any post-deploy failure, `rollback-production` redeploys the **previous
commit's** Edge Functions and fails the run loudly with a step summary.
Database migrations are **forward-only** and intentionally *not* reverted —
keep migrations backward-compatible (expand/contract) and enable **PITR**
(Point-in-Time Recovery) in the Supabase dashboard as the database safety net.

### Environments and secrets

The pipeline targets **two Supabase projects** (a dedicated staging project +
production) via GitHub **Environments** (Settings ▸ Environments). Secrets share
the same *names* across environments; the `environment:` on each job selects the
right values:

| Secret | `staging` environment | `production` environment |
|--------|-----------------------|--------------------------|
| `SUPABASE_PROJECT_REF` | staging project ref | production project ref |
| `SUPABASE_DB_PASSWORD` | staging DB password | production DB password |
| `LOREKIT_SMOKE_TOKEN` | staging `lk_rw_*` token | production `lk_rw_*` token |

Repo-level secret shared by both: `SUPABASE_ACCESS_TOKEN` (a Supabase personal
access token). Add a **required reviewer** on the `production` environment for a
manual approval gate before prod is touched.

### Recommended branch protection

Require a PR to `main` and mark the `ci.yml` **`Typecheck, Test & Lint
(affected)`** and **`Integration tests (local Supabase)`** jobs as required
status checks. Because `deploy.yml` no longer re-runs tests, these checks are
the sole gate that keeps unverified (or migration-breaking) code off `main`.

---

## Prerequisites

1. A Supabase project ([supabase.com](https://supabase.com) → New project)
2. GitHub OAuth app for authentication
3. A Vercel project connected to this repository
4. Supabase CLI installed: `npm install -g supabase`

---

## 1. Link to your Supabase project

```bash
supabase link --project-ref <your-project-ref>
```

Your project ref is the subdomain of your Supabase URL: `https://<project-ref>.supabase.co`.

---

## 2. Apply database migrations

```bash
pnpm nx db:push supabase
# or directly:
supabase db push --project-ref <your-project-ref>
```

This applies:
- `00001_memories.sql` — `memories` table, FTS, indexes, RLS policies
- `00002_api_tokens.sql` — `api_tokens` table, RLS policies

---

## 3. Configure GitHub OAuth

1. Create an OAuth app at [github.com/settings/developers](https://github.com/settings/developers):
   - **Callback URL:** `https://<project-ref>.supabase.co/auth/v1/callback`
2. In Supabase → Auth → Providers → GitHub: enable and paste Client ID + Secret

---

## 4. Set Supabase secrets

```bash
supabase secrets set \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_ANON_KEY=<publishable-key> \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32) \
  OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.europe-west4.gcp.dash0-dev.com \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <DASH0_AUTH_TOKEN>" \
  VERCEL_ENV=production \
  --project-ref <your-project-ref>
```

---

## 5. Deploy Edge Functions

```bash
# Deploy both functions (typecheck runs first via NX):
pnpm nx fn:deploy supabase

# Or directly:
supabase functions deploy mcp --project-ref <your-project-ref>
supabase functions deploy health --no-verify-jwt --project-ref <your-project-ref>
```

**Note:** `health` is deployed with `--no-verify-jwt` so uptime monitors can call it without authentication.

---

## 6. Configure Vercel

In your Vercel project → Settings → General:

| Setting | Value |
|---------|-------|
| Root Directory | `packages/web` |
| Build Command | `cd ../.. && pnpm nx build web --configuration=production` |
| Output Directory | `.next` |
| Install Command | `cd ../.. && pnpm install` |

Environment variables to add:

```
NEXT_PUBLIC_SUPABASE_URL          https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY     <publishable-key>
NEXT_PUBLIC_SUPABASE_PROJECT_REF  <project-ref>
NEXT_PUBLIC_APP_URL               https://<your-vercel-url>.vercel.app
NEXT_PUBLIC_DASH0_OTLP_ENDPOINT   https://ingress.europe-west4.gcp.dash0-dev.com
NEXT_PUBLIC_DASH0_AUTH_TOKEN      <ingesting-only-dash0-token>

OTEL_EXPORTER_OTLP_ENDPOINT       https://ingress.europe-west4.gcp.dash0-dev.com
OTEL_EXPORTER_OTLP_HEADERS        Authorization=Bearer <DASH0_AUTH_TOKEN>
```

Also add your Vercel URL to Supabase → Auth → URL Configuration:
- Site URL: `https://<vercel-url>.vercel.app`
- Redirect URLs: `https://<vercel-url>.vercel.app/api/auth/callback`

---

## 7. Set up the GitHub webhook (optional)

For LoreKit to learn from PR review comments:

1. Repo → Settings → Webhooks → Add webhook
2. Payload URL: `https://<project-ref>.supabase.co/functions/v1/mcp/webhooks/github`
3. Content type: `application/json`
4. Secret: the value of `GITHUB_WEBHOOK_SECRET` you set in step 4
5. Events: **Pull request review comments** + **Pull request reviews**

---

## NX deploy targets

All Supabase operations have NX targets (requires `SUPABASE_PROJECT_REF` in `.env.local`):

```bash
pnpm nx deploy supabase    # typecheck + test → db push → fn:deploy
pnpm nx db:push supabase   # just push migrations
pnpm nx fn:deploy supabase # just deploy functions
pnpm nx health supabase    # curl /health endpoint
pnpm nx db:types supabase  # generate TypeScript types from DB schema
```
