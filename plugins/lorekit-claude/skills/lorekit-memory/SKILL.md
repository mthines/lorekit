---
name: lorekit-memory
description: >
  Shared persistent memory for coding agents, backed by LoreKit's MCP server.
  Reads scoped lessons at the start of a task or when navigating into
  unfamiliar code (narrow-to-broad scope resolution across branch, repo,
  project, and global), and writes a lesson when something goes wrong — a
  stuck loop, a repeated command failure, a surprising gotcha, a near-miss,
  or a wrong assumption that cost time. Lessons are phrased as observations
  (never rigid rules), scoped to the narrowest namespace that fits, and
  deduplicated on write. Use at task start, before risky operations, and
  after any failure or retrospective. Triggers on "read lessons", "check
  memory", "what do we know about", "remember this", "save a lesson",
  "record this gotcha", "capture this lesson", "/lorekit-memory".
user-invocable: true
argument-hint: '[read|write] [scope-hint or lesson]'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
  workflow_type: shared-memory-intake-and-retrospective
  tags:
    - lorekit
    - persistent-memory
    - shared-memory
    - mcp
    - lessons
    - self-improvement
    - retrospective
---

# LoreKit Memory

Give every agent a shared, persistent memory.
Lessons live in LoreKit (a Supabase-backed MCP server), so what one agent
learns on one machine — or in CI — is available to every agent, everywhere,
in the next session.

This skill has two jobs, mirroring the read-on-start / write-on-failure loop
of the `aw` autonomous-workflow agent:

1. **Read** scoped lessons at the start of a task and before risky steps.
2. **Write** a lesson when something goes wrong, so the next run avoids it.

Both jobs run through LoreKit's `memory.*` MCP tools.
If those tools are not connected, this skill is a no-op — say so once and
continue the task; never block work because memory is unavailable.

> **Modes.** Memory has a controllable backend (`lorekit doctor` shows the
> resolved one): `remote` (the hosted LoreKit server — the default), `local`
> (markdown files under a `.lore/` directory in the repo), or `off` (disabled).
> **`local` means _not_ on the hosted website** — local lessons stay in the
> working tree and never sync to the LoreKit dashboard. Commit `.lore/` to
> share them with your team, or gitignore it to keep them private. See the
> `@lorekit/cli` README for the control model and precedence/deny rules.

---

## When to read (intake)

Read at the moments where prior lessons change what you do:

- **Task start** — before planning any non-trivial change.
- **Navigation** — the first time you open an unfamiliar package, module, or subsystem.
- **Before a risky operation** — migrations, deploys, worktree/branch surgery, force pushes, anything hard to reverse.

Follow [rules/intake.md](./rules/intake.md).
The short version: resolve the current scope, list lessons narrow-to-broad,
and treat matches as *considerations*, not commands.

## When to write (retrospective)

Write when a run produces a durable observation worth carrying forward.
The trigger is friction, not success. Ask the 30-second question:

> Was there a stuck loop, a repeated failure, a surprise, a near-miss, or a
> guess that paid off — something a future run would benefit from knowing?

If yes, write it. If the answer is genuinely nothing, write nothing —
empty retrospectives are skipped entirely.

Follow [rules/retrospective.md](./rules/retrospective.md).
The short version: phrase the lesson as an observation, pick the narrowest
scope that fits, check for a near-duplicate first, then `memory.write`.

---

## Scope in one line

Lessons are partitioned by a canonical scope string (`::` is the only separator):

```text
global                                universal principles
project::{name}                       monorepo-wide
repo::{owner}/{repo}                   this repository's codebase
branch::{owner}/{repo}::{branch}       short-lived, this branch only
```

Read narrow-to-broad and merge; write to the narrowest scope that correctly
describes where the lesson applies.
Full resolution rules: [references/scope-resolution.md](./references/scope-resolution.md).

---

## The MCP tools

| Tool | Use | Token |
|------|-----|-------|
| `memory.list` | List lessons for one scope (newest first, tag filter) | read |
| `memory.search` | Full-text search across scopes (supports `repo::owner/*`) | read |
| `memory.read` | Read one lesson by scope + key | read |
| `memory.write` | Store or update a lesson (same scope+key updates in place) | read+write |

Write tools need an `lk_rw_*` token; read tools accept `lk_rw_*` or `lk_ro_*`.
A read-only token cannot write — if a write fails with an authorization error,
report it and move on; do not retry.

Every lesson this skill writes carries the tag `skill::lorekit-memory` plus a
`source::<trigger>` tag (for example `source::stuck-loop`) so lessons are
easy to find and audit later.

---

## Setup

Install the skill and configure the MCP endpoint with the LoreKit CLI:

```bash
npx @lorekit/cli install
npx @lorekit/cli doctor
```

`install` scaffolds this skill into `.claude/skills/` and adds the LoreKit
server to `.mcp.json`.
`doctor` verifies connectivity, token permission, and scope detection.
See the CLI's own README for flags and troubleshooting.
