# LoreKit

**Shared, persistent memory for AI coding agents.**

Your agents learn things — the right worktree naming convention, the DB migration pattern you keep forgetting to tell them, the fix for that recurring Supabase edge case. LoreKit stores those lessons in a central database so every agent on every machine benefits, CI runs included.

```
                   ┌─ persistent-memory skill ─┐
  Agent learns      │  memory.write { scope, key, value } │
  something ──────→│                            │──→ Supabase Postgres
  in a session      │  memory.list { scope }    │←── memories table
                   └───────────────────────────┘
                              ↕ HTTPS + Bearer token
                   https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp
```

## What it solves

| Problem | LoreKit's answer |
|---------|-----------------|
| Skill memory in `.claude/` files lost after CI | Lessons stored in Supabase, survive every run |
| Lessons stuck on one developer's machine | Any agent anywhere reads the same scoped memory |
| Manually capturing PR review comments as lessons | GitHub webhook creates lessons automatically |
| Agents reinventing the wheel on every session | Agents query lore before planning |
| Sharing context across tools (Claude Code, Cursor, CI) | One MCP endpoint, any MCP-compatible client |

## Quick start

### 1. Deploy (5 minutes)

```bash
# Clone and install
git clone https://github.com/mthines/lorekit && cd lorekit
pnpm install

# Link to your Supabase project and apply migrations
supabase link --project-ref <your-project-ref>
pnpm nx deploy supabase
```

### 2. Generate a token

Open the web dashboard → Overview → Step 2 → **Generate new token**.

Choose `Read + Write` for agents that learn, `Read only` for context injection.

### 3. Connect your agent

In `.claude/skills/persistent-memory/config.json`:

```json
{
  "backend": "mcp",
  "mcp": {
    "server": "https://<project-ref>.supabase.co/functions/v1/mcp",
    "auth": { "type": "bearer", "token": "lk_rw_<your-token>" }
  }
}
```

That's it. Your agent's lessons now survive every run and session.

## Agent memory skill + CLI

Prefer a one-command setup? The [`@lorekit/cli`](./packages/cli/) package
installs a companion skill that makes agents use LoreKit autonomously —
reading lessons when they start a task or navigate new code, and writing a
lesson whenever something goes wrong (a stuck loop, a repeated failure, a
gotcha, a costly wrong assumption). It mirrors the read-on-start /
write-on-failure loop of the `aw` autonomous-workflow agent.

```bash
# Scaffold the lorekit-memory skill into .claude/skills and wire .mcp.json
npx @lorekit/cli install \
  --endpoint https://<project-ref>.supabase.co/functions/v1/mcp \
  --token    lk_rw_<your-token>

# Verify connectivity, token permission, and the git-derived scopes
npx @lorekit/cli doctor
```

→ See [packages/cli/README.md](./packages/cli/README.md) for all commands and
flags, and the installed skill's `SKILL.md` for the read/write protocol.

For a **deterministic** version that fires on host lifecycle events (no
reliance on the agent invoking the skill), install a framework plugin. All
three share one engine — the `lorekit hook` command — and differ only in thin
per-host config:

- **Claude Code** — a marketplace plugin (skill + `SessionStart` / failure /
  `Stop` hooks + MCP): `/plugin marketplace add mthines/lorekit` then
  `/plugin install lorekit-memory@lorekit`
- **Cursor** — a rule + `stop` hook
- **Codex** — feature-flagged hooks + an `AGENTS.md` fallback (experimental)

→ See [plugins/README.md](./plugins/README.md).

## Architecture

LoreKit is an NX monorepo with three deployable pieces:

- **MCP server** — Supabase Edge Function (Deno, self-contained)
- **Web dashboard** — Next.js 15 app on Vercel ([lorekit-io.vercel.app](https://lorekit-io.vercel.app))
- **Database** — Supabase Postgres with row-level security

→ See [docs/architecture.md](./docs/architecture.md) for the full diagram.

## Scope system

Lessons are partitioned by canonical scope strings:

```
global                                  # universal lessons
project::agent-skills                  # monorepo-level
repo::mthines/gw-tools                 # repository-level
branch::mthines/gw-tools::feat/x       # branch-level (short-lived)
```

Agents query from narrow to broad and merge results. See [docs/scope-format.md](./docs/scope-format.md).

## MCP tools

| Tool | Description |
|------|-------------|
| `memory.write` | Store or update a lesson |
| `memory.read` | Read a lesson by scope + key |
| `memory.list` | List lessons for a scope (supports tag filtering) |
| `memory.delete` | Delete a lesson |
| `memory.search` | Full-text search; supports `repo::owner/*` wildcard |

→ Full reference: [docs/mcp-tools.md](./docs/mcp-tools.md)

## Authentication

Three tiers — agents use API tokens:

| Token | Format | Use case |
|-------|--------|----------|
| Read + Write | `lk_rw_<32 chars>` | Agents that learn (persistent-memory skill) |
| Read only | `lk_ro_<32 chars>` | CI context injection |
| Service role | `SUPABASE_SERVICE_ROLE_KEY` | Internal / infrastructure |

Tokens are generated in the dashboard, stored as SHA-256 hashes, shown once.

→ See [docs/api-tokens.md](./docs/api-tokens.md)

## Observability

All three layers emit traces, metrics, and logs to Dash0 via OpenTelemetry:

- Edge Function: `lorekit.memory.*` spans with SQL child spans
- Next.js server: HTTP spans via `@vercel/otel`
- Browser: RUM via `@dash0/sdk-web`

Every signal carries `service.namespace=lorekit` and `deployment.environment.name`.

→ Setup: [docs/otel.md](./docs/otel.md)

## Documentation

| | |
|--|--|
| [docs/architecture.md](./docs/architecture.md) | System overview, auth tiers, data model |
| [docs/mcp-tools.md](./docs/mcp-tools.md) | Tool reference with examples |
| [docs/scope-format.md](./docs/scope-format.md) | Scope format spec |
| [docs/api-tokens.md](./docs/api-tokens.md) | Token system |
| [docs/otel.md](./docs/otel.md) | Observability setup |
| [docs/deployment.md](./docs/deployment.md) | Full deployment guide |
| [CLAUDE.md](./CLAUDE.md) | Agent context (NX commands, key decisions) |
