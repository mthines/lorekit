# LoreKit Installation Guide

> This guide is structured so an AI agent can execute every step autonomously, or a developer can follow it manually in about 5 minutes. Each section is self-contained with exact commands.

> Prefer a guided run? Use `/lorekit-self-host`. Choosing between full
> self-host and BYOD? See https://lorekit.io/docs/self-host.

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

Your project ref is the subdomain of your Supabase URL: `https://<your-project-ref>.supabase.co`

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

This applies all migrations in `supabase/migrations/` and creates all required tables, including `memories`, `api_tokens`, `user_limits`, `plans`, `orgs`, `org_members`, `org_invites`, `org_scope_bindings`, `webhook_secrets`, `audit_log`, `usage_events`, and others.

---

## Step 4 — Configure GitHub OAuth (for the web dashboard)

1. Go to https://github.com/settings/developers → OAuth Apps → New OAuth App
   - **Application name:** LoreKit (or any name)
   - **Homepage URL:** `https://<your-vercel-url>.vercel.app` (or `http://localhost:4200` for local dev)
   - **Authorization callback URL:** `https://<your-project-ref>.supabase.co/auth/v1/callback`
2. Note the **Client ID** and generate a **Client Secret**
3. In Supabase → Auth → Providers → GitHub: enable and paste both values

---

## Step 5 — Set Supabase Edge Function secrets

```bash
supabase secrets set \
  SUPABASE_URL=https://<your-project-ref>.supabase.co \
  SUPABASE_ANON_KEY=<publishable-key> \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  ALLOWED_ORIGINS=https://<your-dashboard-domain> \
  OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.europe-west4.gcp.dash0-dev.com \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <dash0-token>" \
  VERCEL_ENV=production \
  --project-ref <your-project-ref>
```

Find the Supabase keys in: Supabase dashboard → Project Settings → API

`ALLOWED_ORIGINS` is only needed if you deploy your own dashboard (Step 8) on
a domain other than `lorekit.io` — with `VERCEL_ENV=production` and no
`ALLOWED_ORIGINS`, the REST CORS allowlist defaults to `https://lorekit.io`
and your own dashboard's requests are blocked. The Dash0/OTel vars are
optional telemetry and safe to omit.

> `GITHUB_WEBHOOK_SECRET` is **not required** — webhook secrets are now
> per-repository and generated from the dashboard (Step 10). The env var is
> a legacy fallback only, for deployments that pre-date per-repo secrets; set
> it (`GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)`) only if you need that
> compatibility path.

---

## Step 6 — Deploy all Edge Functions

```bash
supabase functions deploy --no-verify-jwt --project-ref <your-project-ref>
```

`pnpm nx fn:deploy supabase` only typechecks and deploys `mcp` + `health` —
fine for the hosted project's own deploy pipeline, but it leaves the
`memories` function (used by hooks, the remote CLI commands, and the
dashboard's REST API), `orgs`, `openapi`, `blog`, `profiling`, and
`groom-sweep` undeployed. Deploy all 8 Edge Functions with the command above
instead — it is exactly what `.github/workflows/deploy.yml` runs, and
`supabase/config.toml` sets `verify_jwt = false` for all of them.

Verify the deployment:

```bash
pnpm nx health supabase
# expected: HTTP 200 {"status":"ok","version":"1.0.0","db":"ok","ts":"…"}

curl -s -o /dev/null -w '%{http_code}' https://<your-project-ref>.supabase.co/functions/v1/memories
# expected: 401 (deployed, auth required) — 404 means it did not deploy
```

---

## Step 7 — Generate an API token

A token must be minted on a dashboard that is connected to **your** project —
a token minted on `lorekit.io` only authenticates the hosted project and will
not work against your self-hosted deployment. Open a dashboard connected to
your project first:

- Deploy your own dashboard now (see Step 8 below) and open it, **or**
- Run it locally against your project: set `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `packages/web/.env.local` to your
  project's values, add `http://localhost:4200/api/auth/callback` to
  Supabase → Auth → URL Configuration → Redirect URLs, then run
  `pnpm nx serve web` (it listens on port 4200).

Then, in that dashboard:

1. Go to **Lore Explorer → Step 2: Connect your agent**
2. Click **Generate new token**
3. Enter a name (e.g. `claude-local`, `ci-github-actions`)
4. Choose **Read + Write** for agents that learn, **Read only** for CI context injection,
   or **Write only** for a one-way lesson feeder that should never read
5. Copy the token — it is shown **once only**

Token formats:
- `lk_rw_<32 chars>` — read + write
- `lk_ro_<32 chars>` — read only
- `lk_wo_<32 chars>` — write only

---

## Step 8 — Deploy the web dashboard (optional)

If you want your own dashboard instance (rather than using `lorekit.io`):

1. Import the repo at https://vercel.com/new
2. Set these project settings:
   - Root Directory: `packages/web`
   - Build Command: `cd ../.. && pnpm nx build web --configuration=production`
   - Output Directory: `.next`
   - Install Command: `cd ../.. && pnpm install`
3. Add environment variables:

```
NEXT_PUBLIC_SUPABASE_URL          https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY     <publishable-key>
NEXT_PUBLIC_SUPABASE_PROJECT_REF  <your-project-ref>
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

The fastest path is the CLI — it scaffolds the skill, MCP connection, and lifecycle hooks in one command. `<your-project-ref>` is the same ref you linked in Step 2 — this is YOUR project, never the hosted one:

```bash
npx @lorekit/cli install \
  --endpoint https://<your-project-ref>.supabase.co/functions/v1/mcp \
  --token    lk_rw_<your-token>
```

Almost every `lorekit install` rewrites the MCP entry — a new project, a
global install, `--force`, `--hooks`, `--mcp-json`, `--completions <shell>`, or a re-run after an
upgrade adds a skill — and **without** `--endpoint` it writes the hosted URL.
Only a plain re-run on a fully installed project leaves `.mcp.json` alone.
Always pass `--endpoint`, or export `LOREKIT_MCP_URL` in your shell profile,
on every install.

**Claude Code on the web** clones the repo fresh into an ephemeral container, so
it only sees a committed, repo-root `.mcp.json`. Add `--mcp-json` to also write
that file in a committable form — it authenticates via a `${LOREKIT_TOKEN}`
reference instead of an embedded token, so it holds no secret:

```bash
npx @lorekit/cli install --global --mcp-json \
  --endpoint https://<your-project-ref>.supabase.co/functions/v1/mcp
```

Commit the generated `.mcp.json` and set `LOREKIT_TOKEN` as an environment
secret in the web UI. Note that `.mcp.json` is usually git-ignored (the default
install embeds a token) — un-ignore it before committing, and keep using
`--mcp-json` in that repo so a later plain install never writes a token into the
now-tracked file. The command warns when the file it wrote is still git-ignored,
and again when a plain install is about to replace that committable entry with an
embedded token.
See the [Claude Code on the web guide](https://lorekit.io/docs/claude-code-web).

For any other MCP-compatible agent, add the endpoint and Bearer token to the agent's MCP config directly:

```jsonc
{
  "mcpServers": {
    "lorekit": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
               "https://<your-project-ref>.supabase.co/functions/v1/mcp",
               "--header", "Authorization:Bearer lk_rw_<your-token>"]
    }
  }
}
```

---

## Step 10 — (Optional) Set up the GitHub webhook

To have LoreKit learn from PR review comments automatically. Webhook secrets
are **per-repository** — generate one for each repo you want to webhook:

1. Open the web dashboard → **Lore Explorer → Set up the GitHub webhook**
2. Under **Webhook secrets**, add the repo (`owner/repo`) and copy the
   generated secret — it's shown once
3. Go to that repo on GitHub → Settings → Webhooks → Add webhook
4. **Payload URL:** `https://<your-project-ref>.supabase.co/functions/v1/mcp/webhooks/github`
5. **Content type:** `application/json`
6. **Secret:** the value you copied in step 2
7. **Events:** Pull request review comments + Pull request reviews

Regenerating a repo's secret from the dashboard only affects that repo —
other repos' secrets are untouched.

---

## Verify the full setup

```bash
# 1. Health check
curl https://<your-project-ref>.supabase.co/functions/v1/health
# → {"status":"ok","version":"1.0.0","db":"ok","ts":"…"}

# 2. Write a test lesson
curl -X POST https://<your-project-ref>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer lk_rw_<your-token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory.write","arguments":{"scope":"global","key":"install-test","value":"LoreKit is working."}}}'
# → {"jsonrpc":"2.0","id":1,"result":{"id":"...","created_at":"..."}}

# 3. Read it back
curl -X POST https://<your-project-ref>.supabase.co/functions/v1/mcp \
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
    LOREKIT_MCP_URL: https://<your-project-ref>.supabase.co/functions/v1/mcp
    LOREKIT_TOKEN: ${{ secrets.LOREKIT_TOKEN }}
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `{"code":-32003}` on write | Read-only (`lk_ro_`) token | Generate a `lk_rw_` or `lk_wo_` token |
| `{"code":-32003}` on read | Write-only (`lk_wo_`) token | Generate a `lk_rw_` or `lk_ro_` token |
| `{"code":-32001}` | Missing, invalid, expired or revoked token | Check the `Authorization` header; generate a new token |
| `{"code":-32603}` naming `LOREKIT_STORAGE_SERVICE_KEY` | BYOD storage URL set without the service key | Set `LOREKIT_STORAGE_SERVICE_KEY` on the function project (see [byod.md](./byod.md)); retrying will not help |
| `{"code":-32603}` otherwise | Server fault — DB unreachable or an unexpected exception | Retry; if it persists, check the function logs |
| Tool result with `isError: true` mentioning the scope | Invalid scope format | Use `::` as separator; check scope format |
| `{"db":false}` on health check | DB not reachable from Edge Function | Verify Supabase secrets in Step 5 |
| Dashboard auth loop | Redirect URL not set | Add your URL in Supabase Auth settings (Step 8) |

Full reference: https://github.com/mthines/lorekit/blob/main/docs/mcp-tools.md
