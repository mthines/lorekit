# LoreKit

Supabase-backed MCP server for shared, persistent agent memory. Exposes lessons/memories from AI coding agents (Claude Code, Cursor, etc.) as a standard MCP server — readable and writable across machines, CI pipelines, and PR lifecycle events.

## What it solves

| Problem | LoreKit's answer |
| ------- | ---------------- |
| Skill memory lost after CI run | Lessons stored in Supabase Postgres, not local files |
| Lessons stuck on one developer's machine | Any agent anywhere can read/write via HTTPS + JWT |
| No automatic learning from PR reviews | GitHub webhook creates candidate lessons from PR comments |
| Can't observe what agents are learning | Full OTel telemetry to Dash0 — every tool call is a trace |

## Architecture

```
AI agent (persistent-memory skill)
    │  MCP over HTTPS
    ▼
/mcp ── auth middleware ── tool handlers ── Supabase Postgres
                                    │
/webhooks/github ─── HMAC verify ──┘
                                    │
OTel SDK ──────────── OTLP ──────── Dash0
```

## Quick start

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project named `lorekit`.
2. Enable GitHub OAuth in **Authentication → Providers**.
3. Note your **Project URL**, **anon key**, and **service role key**.

### 2. Apply the database migration

```bash
pnpm supabase db push --project-ref <your-project-ref>
```

### 3. Configure environment

```bash
cp .env.example .env.local
# Fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

### 4. Configure Dash0 telemetry

Get your OTLP endpoint from [Dash0 → Settings → Organization → Endpoints](https://app.dash0.com/settings/endpoints) and an auth token from [Settings → Auth Tokens](https://app.dash0.com/settings/auth-tokens).

```bash
# In .env.local:
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingress.us-east-1.aws.dash0.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <your-dash0-token>
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production
```

For local development without Dash0, use the console exporter:

```bash
OTEL_TRACES_EXPORTER=console OTEL_METRICS_EXPORTER=console
```

### 5. Run locally

```bash
pnpm install
pnpm nx dev mcp-server
# or with watch:
pnpm nx serve mcp-server
```

### 6. Deploy to Supabase Edge Functions

```bash
pnpm supabase functions deploy mcp --project-ref <your-project-ref>
```

> **Note:** Edge Functions (Deno) do not support the Node.js OTel SDK. For full OTel coverage deploy to Fly.io:
> ```bash
> fly deploy
> ```

## Pointing `persistent-memory` at LoreKit

In your project's skill config (`.claude/skills/persistent-memory/config.json` or equivalent), change the storage backend:

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

## Scope format

| Type | Format | Example |
| ---- | ------ | ------- |
| Global | `global` | `global` |
| Project | `project::{name}` | `project::agent-skills` |
| Repository | `repo::{owner}/{repo}` | `repo::mthines/gw-tools` |
| Branch | `branch::{owner}/{repo}::{branch}` | `branch::mthines/gw-tools::feat/x` |

`::` is the only valid separator. Single `:` returns a 400 error.

## MCP tools

| Tool | Description |
| ---- | ----------- |
| `memory.write` | Store or update a lesson at a canonical scope |
| `memory.read` | Read a single lesson by scope + key |
| `memory.list` | List lessons for a scope, optionally filtered by tags |
| `memory.delete` | Delete a lesson by scope + key |
| `memory.search` | Full-text search; supports `repo::owner/*` wildcard |

## CI usage

```yaml
- name: Write lesson to LoreKit
  run: |
    curl -X POST $LOREKIT_URL/mcp \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"memory.write","arguments":{"scope":"repo::$GITHUB_REPOSITORY","key":"ci-lesson","value":"...","tags":["source::ci"]}}}'
```

## Development

```bash
pnpm install
pnpm nx run-many -t typecheck,test,lint --all    # full check
pnpm nx typecheck mcp-core                        # fast typecheck
pnpm nx test mcp-core                             # unit + integration tests
```

Requires a local Supabase for integration tests:

```bash
pnpm supabase start   # starts Postgres + Auth locally
```

## GitHub webhook setup

1. In your GitHub repository: **Settings → Webhooks → Add webhook**
2. Payload URL: `https://<your-lorekit-url>/webhooks/github`
3. Content type: `application/json`
4. Secret: matches `GITHUB_WEBHOOK_SECRET` in your env
5. Events: `Pull request review comments`, `Pull request reviews`
