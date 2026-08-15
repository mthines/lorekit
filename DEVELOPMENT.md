# Development

How to set up the LoreKit monorepo locally, run the checks, and hack on each
package. For **deployment and environment variables** see [SETUP.md](./SETUP.md),
and for **architecture** see [docs/](./docs/README.md).

## Prerequisites

- **Node.js 20+** (the CLI needs 18+, but CI runs on 20 — match it).
- **pnpm** — pinned via `packageManager` in `package.json`. The easiest way to
  get the right version is Corepack:
  ```bash
  corepack enable
  ```
- **Supabase CLI** — only needed for the backend (migrations, edge functions,
  local stack): https://supabase.com/docs/guides/cli
- **Git** with a remote you can push branches to.

## First-time setup

```bash
git clone https://github.com/mthines/lorekit.git
cd lorekit
pnpm install                # installs the whole workspace
cp .env.example .env.local  # fill in values as needed (see SETUP.md)
```

That's enough to run the unit tests, lint, and typecheck. The Supabase and
Vercel bits are only needed when you touch those pieces.

## Repo layout

| Path                   | What                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| `packages/mcp-core/`   | Scope validator, DB client, tool handlers, OTel                             |
| `packages/web/`        | Next.js dashboard (Vercel)                                                  |
| `packages/cli/`        | Zero-dep `@lorekit/cli` — `install` / `doctor` / `hook` / `migrate` / `mcp` |
| `plugins/`             | Per-framework bundles (Claude / Cursor / Codex)                             |
| `supabase/`            | Edge Functions (production MCP server), migrations, live smoke suites       |

See [CLAUDE.md](./CLAUDE.md) for the full package map and key decisions.

## Everyday commands

```bash
# The full CI gate (what must pass before merge)
pnpm nx run-many -t typecheck,test,lint --all

# Only what your change affects (fast; what CI actually runs on a PR)
pnpm nx affected -t typecheck,test,lint

# A single project
pnpm nx test mcp-core          # needs a local Supabase (see below)
pnpm nx test cli               # the CLI's node:test suite
pnpm nx typecheck web
```

## Developing the CLI (`@lorekit/cli`)

The CLI is a zero-dependency Node ESM package — there is **no build step**, so
the fastest loop is to symlink it onto your `PATH` and run the real `lorekit`
command against your working copy.

### Symlink it globally with `npm link`

```bash
cd packages/cli
pnpm link --global
```

This creates a global `lorekit` that points at `packages/cli/bin/lorekit.mjs` in
your checkout. Because it's a symlink to the source (and the package has no
dependencies to build), **edits are picked up immediately** — no reinstall, no
recompile. Verify it:

```bash
which lorekit        # -> .../bin/lorekit  (a symlink into your checkout)
lorekit --version    # reads packages/cli/package.json
lorekit doctor       # run it against the current directory
```

> Using pnpm instead of npm? From `packages/cli` run `pnpm link --global`. If the
> global bin isn't on your `PATH`, run `pnpm setup` once and restart the shell.

### Remove the symlink

```bash
pnpm unlink --global @lorekit/cli
```

### Run it without linking

You don't have to link at all — you can invoke the entrypoint directly:

```bash
node packages/cli/bin/lorekit.mjs doctor
node packages/cli/bin/lorekit.mjs --help
```

### Test the CLI

```bash
pnpm nx test cli                       # via NX
# or directly:
cd packages/cli && node --test test/*.test.mjs
```

The suite covers unit logic, spawns the real `lorekit hook` binary per
adapter/event, replays cross-framework fixtures, and validates the plugin
wiring. See [`packages/cli/README.md`](./packages/cli/README.md) for the layers
and how to harvest fresh fixtures.

### Keep the vendored skill in sync

The Claude plugin ships a copy of the skill under
`plugins/lorekit-claude/skills/`. If you edit `packages/cli/skill/`, re-sync it:

```bash
node scripts/sync-plugin-skill.mjs           # apply
node scripts/sync-plugin-skill.mjs --check   # verify (what CI does)
```

## Backend (Supabase)

`mcp-core` tests and any edge-function work need a local Supabase running:

```bash
pnpm nx start supabase     # start the local stack (Postgres + functions)
pnpm nx test mcp-core      # now the DB-backed tests can run
pnpm nx fn:dev supabase    # serve the Edge Functions locally
```

Migrations live in `supabase/migrations/` and are forward-only. Deployment is
automated on merge to `main` — see [docs/deployment.md](./docs/deployment.md).

## Web dashboard

```bash
pnpm nx serve web          # Next.js dev server
pnpm nx typecheck web
```

Environment variables for the dashboard are documented in [SETUP.md](./SETUP.md).

## Commits and releases

This repo uses [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `feat!:` / `BREAKING CHANGE:` for
majors). They drive the automated `@lorekit/cli` release via release-please:
you never bump the version by hand — merging the release PR cuts the version,
changelog, tag, and npm publish.

## Before you push

Run the gate locally so CI is green on the first try:

```bash
pnpm nx affected -t typecheck,test,lint
```

Then push your branch and open a PR against `main`. CI (`ci.yml`) runs the
required checks; `main` deploys automatically once merged.
