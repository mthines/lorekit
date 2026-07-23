# Deployment

LoreKit has three deployable pieces. Each has its own deployment path.

## Overview

| Piece | Platform | Deploy command |
|-------|----------|----------------|
| MCP server + health check | Supabase Edge Functions | `pnpm nx fn:deploy supabase` |
| Web dashboard | Vercel | Auto-deploy on `git push main` |
| Database migrations | Supabase | `pnpm nx db:push supabase` |

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
