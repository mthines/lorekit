# LoreKit

> Shared, persistent memory for your AI coding agents.

[![CI](https://github.com/mthines/lorekit/actions/workflows/ci.yml/badge.svg)](https://github.com/mthines/lorekit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@lorekit/cli.svg)](https://www.npmjs.com/package/@lorekit/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Your coding agent figures something out — the migration pattern you keep
forgetting to mention, the fix for that flaky test, the reason a build breaks on
CI but not locally. Then the session ends, and it forgets. Tomorrow you explain
it again.

LoreKit gives your agents a memory that outlives the session. Lessons are
written once and recalled everywhere: your machine, your teammates' machines,
CI, and whichever tool you happen to be using that day.

```
                   ┌─ your agent, any tool, any machine ─┐
  learns something │  memory.write { scope, key, value } │
  in a session ───→│                                     │──→ one shared store
  recalls it next  │  memory.list  { scope }             │←── (Supabase Postgres)
  time it needs it └─────────────────────────────────────┘
```

## The problem you have right now

If you use AI coding agents daily, you're paying a quiet tax:

- **Every session starts from zero.** The agent that just untangled a tricky bug
  has no memory of it an hour later. You re-explain the same context, over and
  over.
- **Lessons are trapped on one machine.** What your agent learned on your laptop
  never reaches your teammate's agent — or the same agent running in CI.
- **Every tool is its own island.** What Claude Code figured out, Cursor doesn't
  know. What you learned locally, GitHub Actions can't see.
- **Good context dies quietly.** The `.claude/` notes your agent writes are
  wiped on the next CI run and rarely make it back to you.

The knowledge exists. It just has nowhere to live.

## What LoreKit gives you

- **A memory that persists.** Lessons are stored in a database, not a scratch
  file — they survive session ends, machine reboots, and CI runs.
- **One brain for every agent.** Any MCP-compatible agent, anywhere, reads and
  writes the same memory. Your laptop, your team, your pipeline — one source of
  truth.
- **Scoped so it stays relevant.** Memory is partitioned by scope, so an agent
  gets the lessons for *this* repo and branch without drowning in noise from
  everything else (see [How memory is organized](#how-memory-is-organized)).
- **Learns from your code reviews.** Point a GitHub webhook at LoreKit and PR
  review comments become durable lessons automatically — no copy-paste.
- **Works with the tools you already use.** Claude Code, Cursor, Codex, or any
  MCP client. One endpoint, one token.

## Get started

You don't have to run anything yourself — LoreKit is hosted. Getting your agents
connected takes three steps.

### 1. Get a token

Sign in to the dashboard at
[lorekit-io.vercel.app](https://lorekit-io.vercel.app) with GitHub, then
**Overview → Connect your agent → Generate new token**.

Pick **Read + Write** for agents that should learn, or **Read only** for
context-injection-only setups like CI.

Your token is shown once — copy it now.

### 2. Connect your agent

The fastest path is the CLI. It scaffolds a companion skill that makes your
agent use LoreKit on its own: reading relevant lessons when it starts a task,
and writing one whenever something goes wrong — a stuck loop, a repeated
failure, a costly wrong assumption.

```bash
npx @lorekit/cli install \
  --endpoint https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp \
  --token    lk_rw_<your-token>
```

Check that everything is wired up:

```bash
npx @lorekit/cli doctor
# → connectivity, token permission, and detected scopes, all green
```

### 3. That's it

Your agent now remembers. Its lessons survive every session, reach every machine
running the same token, and are there the next time any agent picks up the work.

> **Prefer a framework plugin?** For memory that fires on host lifecycle events
> — no reliance on the agent choosing to use the skill — install a plugin
> instead. Claude Code has a one-line marketplace install; Cursor and Codex have
> their own bundles. See [plugins/](./plugins/README.md).

## How memory is organized

Lessons are partitioned by **scope** — a short string that says how widely a
lesson applies:

```
global                             # applies everywhere
project::agent-skills              # one project
repo::mthines/gw-tools             # one repository
branch::mthines/gw-tools::feat/x   # one branch (short-lived)
```

An agent reads from narrow to broad — branch, then repo, then global — and
merges what it finds. So a branch-specific gotcha and a universal convention both
surface, without unrelated repos leaking in. Full spec:
[docs/scope-format.md](./docs/scope-format.md).

## Works with your tools

| Tool | How it connects |
|------|-----------------|
| **Claude Code** | Marketplace plugin (skill + lifecycle hooks + MCP), or the CLI above |
| **Cursor** | A rule plus a `stop` hook |
| **Codex** | Feature-flagged hooks with an `AGENTS.md` fallback (experimental) |
| **Any MCP client** | Point it at the endpoint with a Bearer token |

All the integrations share one engine and differ only in how each host wires it
up. See [plugins/README.md](./plugins/README.md).

## Documentation

| Guide | What it covers |
|-------|----------------|
| [docs/scope-format.md](./docs/scope-format.md) | How scopes work and how agents resolve them |
| [docs/mcp-tools.md](./docs/mcp-tools.md) | The `memory.*` tools, with request/response examples |
| [docs/api-tokens.md](./docs/api-tokens.md) | Token types, permissions, and CI usage |
| [docs/limits.md](./docs/limits.md) | Memory caps and rate limits |
| [packages/cli/README.md](./packages/cli/README.md) | Every CLI command and flag |
| [docs/](./docs/README.md) | Everything else — architecture, deployment, observability |

## Run your own instance

LoreKit is fully self-hostable — the whole stack (MCP server, dashboard,
database) deploys to your own Supabase and Vercel projects in about five
minutes. See [docs/install.md](./docs/install.md).

## Contributing

LoreKit is an NX monorepo. To set it up locally, run the checks, and hack on any
package, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## License

[MIT](./LICENSE) © LoreKit contributors.
