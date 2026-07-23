# LoreKit Installation Guide

> This guide is structured so an AI agent can execute every step autonomously, or a developer can follow it manually in about 5 minutes. Each section is self-contained with exact commands.

---

## Prerequisites

The following must be available before starting:

| Requirement | Check | Install |
|-------------|-------|---------|
| Node.js ≥ 18 | `node -v` | https://nodejs.org |
| pnpm | `pnpm -v` | `npm install -g pnpm` |
| Supabase CLI | `supabase -v` | `npm install -g supabase` |
| Git | `git --version` | https://git-scm.com |
| A Supabase project | — | https://supabase.com → New project |
| A Vercel account (optional — for the web dashboard) | — | https://vercel.com |

---

## Step 1 — Clone and install

```bash
git clone https://github.com/mthines/lorekit
cd lorekit
pnpm install
```

---

## Step 2 — Link to your Supabase project

Your project ref is the subdomain of your Supabase URL: `https://<project-ref>.supabase.co`

```bash
supabase link --project-ref <your-project-ref>
```

Create a `.env.local` file in the repo root (needed for NX targets):

```bash
echo "SUPABASE_PROJECT_REF=<your-project-ref>" > .env.local
```

---

## Step 3 — Apply database migrations

```bash
pnpm nx db:push supabase
```

This creates two tables:
- `memories` — lesson storage with full-text search and row-level security
- `api_tokens` — hashed token store

---

## Step 4 — Configure GitHub OAuth (for the web dashboard)

1. Go to https://github.com/settings/developers → OAuth Apps → New OAuth App
   - **Application name:** LoreKit (or any name)
   - **Homepage URL:** `https://<your-vercel-url>.vercel.app` (or `http://localhost:3000` for local dev)
   - **Authorization callback URL:** `https://<project-ref>.supabase.co/auth/v1/callback`
2. Note the **Client ID** and generate a **Client Secret**
3. In Supabase → Auth → Providers → GitHub: enable and paste both values

---

## Step 5 — Set Supabase Edge Function secrets

```bash
supabase secrets set \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_ANON_KEY=<publishable-key> \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32) \
  OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.europe-west4.gcp.dash0-dev.com \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <dash0-token>" \
  VERCEL_ENV=production \
  --project-ref <your-project-ref>
```

Find the Supabase keys in: Supabase dashboard → Project Settings → API

---

## Step 6 — Deploy the MCP server

```bash
pnpm nx fn:deploy supabase
```

This typechecks and deploys two Edge Functions:
- `mcp` — the MCP server (requires auth)
- `health` — unauthenticated health check endpoint

Verify the deployment:

```bash
pnpm nx health supabase
# expected: {"status":"ok","db":true}
```

---

## Step 7 — Generate an API token

1. Open the web dashboard: https://lorekit-io.vercel.app/dashboard (or your own Vercel URL after step 8)
2. Go to **Overview → Step 2: Connect your agent**
3. Click **Generate new token**
4. Enter a name (e.g. `claude-local`, `ci-github-actions`)
5. Choose **Read + Write** for agents that learn, **Read only** for CI context injection
6. Copy the token — it is shown **once only**

Token formats:
- `lk_rw_<32 chars>` — read + write
- `lk_ro_<32 chars>` — read only

---

## Step 8 — Deploy the web dashboard (optional)

If you want your own dashboard instance (rather than using `lorekit-io.vercel.app`):

1. Import the repo at https://vercel.com/new
2. Set these project settings:
   - Root Directory: `packages/web`
   - Build Command: `cd ../.. && pnpm nx build web --configuration=production`
   - Output Directory: `.next`
   - Install Command: `cd ../.. && pnpm install`
3. Add environment variables:

```
NEXT_PUBLIC_SUPABASE_URL          https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY     <publishable-key>
NEXT_PUBLIC_SUPABASE_PROJECT_REF  <project-ref>
NEXT_PUBLIC_APP_URL               https://<your-vercel-url>.vercel.app
NEXT_PUBLIC_DASH0_OTLP_ENDPOINT   https://ingress.europe-west4.gcp.dash0-dev.com
NEXT_PUBLIC_DASH0_AUTH_TOKEN      <ingesting-only-dash0-token>
OTEL_EXPORTER_OTLP_ENDPOINT       https://ingress.europe-west4.gcp.dash0-dev.com
OTEL_EXPORTER_OTLP_HEADERS        Authorization=Bearer <dash0-token>
```

4. Add your Vercel URL in Supabase → Auth → URL Configuration:
   - Site URL: `https://<vercel-url>.vercel.app`
   - Redirect URLs: `https://<vercel-url>.vercel.app/api/auth/callback`

---

## Step 9 — Connect your agent

Add the MCP config to your agent. For Claude Code (`.claude/skills/persistent-memory/config.json`):

```json
{
  "backend": "mcp",
  "mcp": {
    "server": "https://<project-ref>.supabase.co/functions/v1/mcp",
    "auth": {
      "type": "bearer",
      "token": "lk_rw_<your-token>"
    }
  }
}
```

For any other MCP-compatible agent, point the client at the same endpoint with the same Bearer token.

---

## Step 10 — (Optional) Set up the GitHub webhook

To have LoreKit learn from PR review comments automatically:

1. Go to your repo → Settings → Webhooks → Add webhook
2. **Payload URL:** `https://<project-ref>.supabase.co/functions/v1/mcp/webhooks/github`
3. **Content type:** `application/json`
4. **Secret:** the value of `GITHUB_WEBHOOK_SECRET` you set in Step 5
5. **Events:** Pull request review comments + Pull request reviews

---

## Verify the full setup

```bash
# 1. Health check
curl https://<project-ref>.supabase.co/functions/v1/health
# → {"status":"ok","db":true}

# 2. Write a test lesson
curl -X POST https://<project-ref>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer lk_rw_<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory.write","arguments":{"scope":"global","key":"install-test","value":"LoreKit is working."}}}'
# → {"jsonrpc":"2.0","id":1,"result":{"id":"...","created_at":"..."}}

# 3. Read it back
curl -X POST https://<project-ref>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer lk_ro_<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory.read","arguments":{"scope":"global","key":"install-test"}}}'
# → {"jsonrpc":"2.0","id":2,"result":{"value":"LoreKit is working.","updated_at":"..."}}
```

---

## CI / GitHub Actions

Store a read+write token as `LOREKIT_TOKEN` in your repo secrets, then use it in any workflow step:

```yaml
- name: Inject LoreKit context
  run: |
    curl -s -X POST "$LOREKIT_MCP_URL" \
      -H "Authorization: Bearer $LOREKIT_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory.list","arguments":{"scope":"repo::${{ github.repository }}"}}}'
  env:
    LOREKIT_MCP_URL: https://<project-ref>.supabase.co/functions/v1/mcp
    LOREKIT_TOKEN: ${{ secrets.LOREKIT_TOKEN }}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `{"code":-32001}` on write | Read-only token | Generate a `lk_rw_` token |
| `{"code":-32001}` on read | Missing or wrong token | Check the `Authorization` header |
| `{"code":-32603}` | Scope validation error | Use `::` as separator; check scope format |
| `{"db":false}` on health check | DB not reachable from Edge Function | Verify Supabase secrets in Step 5 |
| Dashboard auth loop | Redirect URL not set | Add your URL in Supabase Auth settings (Step 8) |

Full reference: https://github.com/mthines/lorekit/blob/main/docs/mcp-tools.md
