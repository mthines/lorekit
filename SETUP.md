# Technical Reference

> **New here?** The in-product onboarding at [lorekit-io.vercel.app/dashboard](https://lorekit-io.vercel.app/dashboard) walks you through connecting your first agent step by step. This file is a technical reference for CLI operations and environment variables.

---

## Environment variables

### Supabase

| Variable | Where | Description |
|----------|-------|-------------|
| `SUPABASE_URL` | Server + Edge Function secrets | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Server + Edge Function secrets | Publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function secrets only | Never expose to browser |
| `SUPABASE_PROJECT_REF` | `.env.local` | Subdomain of your Supabase URL — used by `pnpm nx db:push` |

### Vercel (web dashboard)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable key |
| `NEXT_PUBLIC_SUPABASE_PROJECT_REF` | Project ref (for CORS pattern) |
| `NEXT_PUBLIC_APP_URL` | Your Vercel URL |
| `NEXT_PUBLIC_DASH0_OTLP_ENDPOINT` | Dash0 OTLP HTTP endpoint |
| `NEXT_PUBLIC_DASH0_AUTH_TOKEN` | Ingesting-only Dash0 token (public — visible in bundle) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Dash0 OTLP endpoint (server-side) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer <token>` |

### Supabase Edge Function secrets

```bash
supabase secrets set \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_ANON_KEY=<publishable-key> \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32) \
  OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.europe-west4.gcp.dash0-dev.com \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <dash0-token>" \
  VERCEL_ENV=production \
  --project-ref <your-project-ref>
```

---

## CLI commands

### One-time setup

```bash
# 1. Link Supabase project
supabase link --project-ref <your-project-ref>

# 2. Apply migrations + deploy functions
pnpm nx deploy supabase
```

### Supabase NX targets

```bash
pnpm nx deploy supabase     # typecheck + test → db push + fn:deploy (full pipeline)
pnpm nx db:push supabase    # push pending migrations
pnpm nx fn:deploy supabase  # deploy mcp + health Edge Functions
pnpm nx db:types supabase   # generate TypeScript types from DB
pnpm nx health supabase     # curl /health + jq
pnpm nx start supabase      # start local Supabase for dev
pnpm nx fn:dev supabase     # run Edge Functions locally
pnpm nx db:reset supabase   # reset local DB (dev only)
```

### NX dev & CI

```bash
pnpm nx run-many -t typecheck,test,lint --all    # full CI gate
pnpm nx typecheck web                            # web app
pnpm nx serve web                                # Next.js dev server
pnpm nx test mcp-core                            # needs supabase start
```

---

## Vercel project settings

| Setting | Value |
|---------|-------|
| Root Directory | `packages/web` |
| Build Command | `cd ../.. && pnpm nx build web --configuration=production` |
| Output Directory | `.next` |
| Install Command | `cd ../.. && pnpm install` |

---

## GitHub Actions CI secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_PROJECT_REF` | Your project ref |
| `SUPABASE_ACCESS_TOKEN` | From [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) |

---

## Supabase Auth configuration

1. **GitHub OAuth** — Auth → Providers → GitHub → Enable → paste Client ID + Secret
   - GitHub OAuth callback URL: `https://<ref>.supabase.co/auth/v1/callback`
2. **Redirect URLs** — Auth → URL Configuration:
   - Site URL: `https://<vercel-url>.vercel.app`
   - Redirect URL: `https://<vercel-url>.vercel.app/api/auth/callback`
