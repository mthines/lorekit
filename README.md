<div align="center">

<img width="120" height="120" alt="LoreKit logo" src="https://github.com/user-attachments/assets/d65ac2d4-0a52-483b-9efe-427dfa45c026" />

# LoreKit

**Shared, persistent memory for your AI coding agents.**

Your agent solves something once — a migration gotcha, a flaky-test fix, why the
build breaks only on CI — and **remembers it in every session after, on every
machine, across every tool.** One `npx` command to connect; works with Claude
Code, Cursor, Codex, or any MCP client.

[![Deploy](https://github.com/mthines/lorekit/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/mthines/lorekit/actions/workflows/deploy.yml)
[![npm](https://img.shields.io/npm/v/@lorekit/cli.svg)](https://www.npmjs.com/package/@lorekit/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

```bash
npx @lorekit/cli install     # connect your agent — full setup below
```

```
                   ┌─ your agent, any tool, any machine ─┐
  learns something │  memory.write { scope, key, value } │
  in a session ───→│                                     │──→ one store, your call:
  recalls it next  │  memory.list  { scope }             │←── remote (shared) or local
  time it needs it └─────────────────────────────────────┘
```

## The problem: your agents forget everything

Every coding agent starts each session with total amnesia. If you use them
daily, that costs you:

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
- **Remote or local — your call.** Use the shared remote store for cross-machine
  sharing, or keep memory in plain markdown files on your own disk — no account,
  no network. Switch between the two whenever you like.

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

## Remote or local — your choice

LoreKit needs neither an account nor a network. The same `memory.*` tools can
run against **plain markdown files on your machine** instead of the shared
remote store — fully offline, nothing to sign up for.

| | Remote (shared) | Local |
|--|-----------------|-------|
| Where lessons live | A shared remote store the whole team reaches | Markdown files under `~/.lorekit/` and `<repo>/.lorekit/` |
| Best for | Sharing across machines, teammates, and CI | Private, offline, or air-gapped work |
| Setup | A token (above) | No account, no token |
| Sharing | Automatic, everywhere the token is used | Commit `<repo>/.lorekit/` to share via git — or gitignore it to keep private |

Local memory is **two-tier**, mirroring the remote scope model: a per-user
`~/.lorekit/` holds global lessons, and an opt-in `<repo>/.lorekit/` holds
repo- and branch-scoped ones. Reads merge both tiers with the closer scope
winning. Every lesson is a human-readable markdown file — greppable and
diffable, not a database you have to query.

To run local, point your agent's `.mcp.json` at the CLI's built-in local server
(no endpoint, no token needed):

```jsonc
{
  "mcpServers": {
    "lorekit": { "command": "npx", "args": ["-y", "@lorekit/cli", "mcp"] }
  }
}
```

Then select local mode — set `LOREKIT_MODE=local`, or add `{ "mode": "local" }`
to a `.lorekit.json` at your repo root — and create `<repo>/.lorekit/` when you
want repo-scoped lessons to persist in the project.

> **Not committed to one?** Start local and move to remote later (or the
> reverse) with `lorekit migrate` — lessons are never stranded. You can also
> hard-deny a mode for privacy or CI (e.g. `LOREKIT_DENY=remote`).

Full details — the two-tier layout, write routing, the control model, and
migration — are in
[packages/cli/README.md](./packages/cli/README.md#memory-modes--the-control-model).

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

