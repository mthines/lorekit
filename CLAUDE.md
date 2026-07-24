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
| `@lorekit/cli` | `packages/cli/` | Zero-dep Node CLI: `install` (scaffolds the `lorekit-memory` skill + `.mcp.json`), `doctor` (connectivity/token/scope health checks), and `hook` (the shared hook engine behind the plugins). Ships the skill under `skill/lorekit-memory/`. Verified by its own `node:test` suite; excluded from the NX TS lint gate. |
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
