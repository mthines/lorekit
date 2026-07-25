# @lorekit/cli

Install the **LoreKit shared-memory skill** into a project and run health
checks against your LoreKit MCP server — a small, zero-dependency Node CLI.

LoreKit gives coding agents a shared, persistent memory: lessons one agent
learns are stored centrally and read by every other agent, in every session,
CI included. This CLI wires an agent up to it in two commands.

## Install

Install it globally — recommended. You get one pinned version, the `lorekit`
command stays on your `PATH`, and the plugin hooks (which call `lorekit hook`
on every lifecycle event) fire instantly instead of paying an `npx` resolution
cost each time:

```bash
npm install -g @lorekit/cli
lorekit install
lorekit doctor
```

Upgrade later with `npm install -g @lorekit/cli@latest`.

Prefer not to install anything? Run it on demand with `npx` — same commands,
always the latest version, fetched and cached per use:

```bash
npx @lorekit/cli install
npx @lorekit/cli doctor
```

Requires Node 18+ (for the built-in `fetch`). No dependencies. Works on macOS,
Linux, and Windows (npm creates the `lorekit` shim on every platform).

## Commands

### `lorekit install`

Sets up the full memory loop — the same three parts as the Claude plugin,
without needing a marketplace:

1. **Skill** (`lorekit-memory`) — the model-invoked authoring judgment.
2. **MCP server** (`lorekit`) — the connection to your lessons, merged into the
   MCP config (preserving any other servers).
3. **Hooks** — the *deterministic* layer: lessons injected on every
   `SessionStart`, a nudge on tool failure (`PostToolUseFailure`), and a
   retrospective nudge on `Stop`. These fire the shared `lorekit hook` engine
   and are merged into `settings.json` (existing hooks preserved).

It first asks **where** to install:

- **project** (default) — `.claude/skills/`, `.mcp.json`, `.claude/settings.json`.
  Scoped to this repo; commit it to share with your team.
- **global** — `~/.claude/skills/`, `~/.claude.json`, `~/.claude/settings.json`.
  Applies to every project you open. Your token lands in `~/.claude.json`, so
  keep that file private.

```bash
lorekit install \
  --endpoint https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp \
  --token    lk_rw_your_token

lorekit install --global      # set it up for every project
```

In a TTY it prompts for the scope (and for `--endpoint` / `--token` if missing).
Flags: `--project` / `--global` pick the scope non-interactively; `--no-hooks`
installs the skill + MCP only (memory stays model-invoked); `--yes` runs
non-interactively (endpoint required via flag/env; scope defaults to project);
`--force` overwrites an existing skill copy. Re-running is idempotent — the hook
entries are updated in place, never duplicated.

> The hook command uses a global `lorekit` when one is on your `PATH` (fast),
> otherwise `npx -y @lorekit/cli`. Installing the CLI globally
> (`npm i -g @lorekit/cli`) is recommended so hooks fire without an npx
> resolution each time.

### `lorekit doctor`

Verifies the setup and prints a status report:

- Node runtime is 18+
- the `lorekit-memory` skill is installed
- the **resolved memory mode and which source decided it**, plus any active
  deny constraints
- for `local`: the store path, entry count, and whether it is committed or
  gitignored
- for `remote`: `.mcp.json` has a `lorekit` server, the endpoint is real (not
  the `<project-ref>` placeholder), the token and its permission tier
  (`lk_rw_*` vs `lk_ro_*`), and that the endpoint is reachable
- for `off`: a note that memory is disabled
- the git-derived read/write scopes for the current directory

```bash
lorekit doctor            # config + connectivity checks
lorekit doctor --deep     # also does a write → read → delete round-trip (needs lk_rw_*)
```

Exit code is non-zero if any check fails, so it fits CI gates.

### `lorekit hook`

The **shared hook engine** behind the Claude Code / Cursor / Codex plugins.
It is not run by hand — the plugins wire it into their hook config. It reads
the host framework's JSON on stdin and prints that host's injection format on
stdout (lessons at session start; a nudge on failure or at end of turn),
always exiting 0 so it can never block the host agent.

```bash
lorekit hook --adapter <claude|cursor|codex> --event <SessionStart|Stop|…>
```

One engine serves all three hosts; each `--adapter` only reshapes input/output
to that host's contract. See [`plugins/`](../../plugins/) for the bundles.

### `lorekit mcp`

A **local stdio MCP server**. It exposes LoreKit's `memory.*` tools backed by
the store the [control model](#memory-modes--the-control-model) resolves, so an
agent's `.mcp.json` can point at the CLI instead of `mcp-remote <url>` — giving
the model discoverable, autonomous `memory.*` tool calls **offline against the
local `.lorekit/` store** (no network, Bash-restricted contexts included).

```bash
lorekit mcp                 # serve on stdin/stdout using the resolved mode
lorekit mcp --mode local --store .lorekit
```

It speaks JSON-RPC 2.0 over newline-delimited stdin/stdout (the MCP stdio
transport, hand-rolled — zero dependencies) and is **not run by hand**: only
JSON-RPC frames reach stdout. It serves whatever mode resolves — `local` serves
the `.lorekit/` files directly, `remote` passes calls through to the hosted
endpoint, and `off` advertises no tools. Tools advertised: `memory.write`,
`memory.read`, `memory.list`, `memory.search`, `memory.delete`,
`memory.archive`.

Wire it into `.mcp.json` as an alternative to the `mcp-remote <url>` transport —
this variant needs no endpoint or token for local mode:

```jsonc
{
  "mcpServers": {
    "lorekit": {
      "command": "npx",
      "args": ["-y", "@lorekit/cli", "mcp"]
    }
  }
}
```

## Memory modes & the control model

Memory has a controllable backend. Three **modes**:

| Mode | Where lessons live | Notes |
|------|--------------------|-------|
| `off` | nowhere | Memory is disabled — every hook event and store op is a silent no-op. |
| `local` | markdown files in two tiers (see below) | **Local means _not_ on the hosted website** — local lessons never sync to the LoreKit dashboard. That is the point of local: private-by-default, greppable, git-native. |
| `remote` | the LoreKit MCP server (hosted) | The shared, cross-machine backend. Reads stay silent until an endpoint + token are configured. This is the default. |

### Local store layout — two tiers

Local mode mirrors the two-tier model used by the `aw` / persistent-memory
loops: a per-user **home** tier plus an opt-in per-repo **project** tier.

| Tier | Path | Availability |
|------|------|--------------|
| **home** | `~/.lorekit/` (override with `LOREKIT_HOME`) | Always available — per-user, cross-repo. |
| **project** | `<repo>/.lorekit/` (override with `LOREKIT_STORE`) | **Opt-in:** active only when the directory exists. Create it once to start persisting repo/branch lessons in the project. |

Each tier is foldered by canonical scope, one markdown file per lesson, with
YAML frontmatter (`scope, key, tags, source_agent, trigger, created, updated,
archived_at`) and the lesson as the body:

```
~/.lorekit/            <repo>/.lorekit/     (opt-in)
├── config.json        ├── global/
├── global/            ├── repo/<owner>/<repo>/
├── repo/<o>/<r>/      └── branch/<owner>/<repo>/<branch>/
└── branch/<o>/<r>/…       └── <slug-of-key>.md
```

**Read = two-tier merge.** For each scope in the read order, entries from both
tiers are unioned and the **project tier wins on a key collision** (closer scope
wins), consistent with the remote narrow→broad merge.

**Write routing by scope:**

- `global` → **home** tier.
- `repo::` / `branch::` → **project** tier when it exists (opted-in), else the
  **home** tier.

To start persisting repo/branch lessons in the project, create
`<repo>/.lorekit/` (or run `lorekit migrate --to project --yes`). Commit it to
share lessons with your team (git-native sharing); add it to `.gitignore` to
keep them private to your checkout.

**Delete / archive across tiers.** Deleting or archiving a key removes the
closest (project) copy first; a broader **home** copy, if any, remains and takes
a second delete. This is deliberate — one `delete` never reaches through and
erases your cross-repo home lesson.

> **Same tiering, two realizations (local ⟷ remote).** The tiered, closer-wins
> merge-read is identical in both backends. Local expresses "universal vs
> team-shared" as two physical **locations** (home dir vs committed project
> dir); remote expresses the same distinction through the canonical **scopes**
> in one shared DB (`global` ≈ your cross-repo home, `repo::` ≈ team-shared) —
> sharing comes from the account/token, so remote needs no second location.
> Different mechanism, same concept.

### `lorekit migrate` — relocation / rename tool

Moved or renamed a local store (e.g. an old `.lore/`)? `migrate` re-writes its
entries into the current two-tier layout so lessons are never stranded:

```bash
lorekit migrate --from .lore              # dry-run: preview counts per scope
lorekit migrate --from .lore --yes        # apply, routing each entry by scope
lorekit migrate --from .lore --to project --yes   # force all entries into the project tier
```

Dry-run (preview) by default; `--yes` (or `--apply`) applies. Idempotent — a
re-run is a no-op. It reads LoreKit's own on-disk format only (it does **not**
import persistent-memory's `~/.agent-memory/<bucket>/` format).

### The control model — two layers, deny-wins

Two config layers decide the mode:

- **User / machine** — env `LOREKIT_MODE`, `LOREKIT_HOME`, `LOREKIT_STORE`,
  `LOREKIT_DENY` (and `LOREKIT_MCP_URL` / `LOREKIT_TOKEN` for remote), plus a
  user config file `~/.lorekit/config.json`.
- **Repo / team** — a `.lorekit.json` at the repo root (and/or the existing
  `lorekit` block in `.mcp.json` for the connection).

Both files share one schema:

```jsonc
{
  "mode": "local",        // select a mode (off | local | remote)
  "store": ".lorekit",    // project-tier store dir (relative to repo root, or absolute)
  "deny": ["remote"]      // forbid modes outright — deny always wins
}
```

**Precedence (a _selection_ within what is allowed):**
`env LOREKIT_MODE` → user config `mode` → repo config `mode` → built-in default
(`remote`).

**Constraints (`deny`) always win.** Denies are a **union** across every source
and only ever accumulate — a user-level hard opt-out is a **ceiling the repo
cannot override**:

- A user who declares `"deny": ["remote"]` (privacy / compliance) can never be
  flipped to remote by any repo default or env flag — they resolve to `local`
  (if they selected it) or `off`, never `remote`.
- A repo or CI job that declares `"deny": ["local"]` (no `.lorekit/` in the tree)
  makes local unselectable there — an env `LOREKIT_MODE=local` is capped, and
  resolution falls through to `remote`, or `off` if both are denied.

`off` is never deniable, so it is always the terminal fallback. Run
`lorekit doctor` to see the resolved mode, **which source decided it**, and any
active deny constraints.

## Options

| Flag | Meaning |
|------|---------|
| `-d, --dir <path>` | Target project root (default: cwd) |
| `--project` | Install into this repo: `.claude/skills` + `.mcp.json` (`install`; default) |
| `--global` | Install for every project: `~/.claude/skills` + `~/.claude.json` (`install`) |
| `-e, --endpoint <url>` | LoreKit MCP endpoint |
| `-t, --token <token>` | LoreKit token |
| `--mode <mode>` | Memory mode override for `doctor`: `off` / `local` / `remote` |
| `--store <path>` | Local project-tier store directory (default `.lorekit`) |
| `--from <path>` | Source store to migrate from (`migrate`) |
| `--to <tier>` | Migration destination tier: `home` / `project` (`migrate`; default routes by scope) |
| `--apply` | Apply the migration — alias of `--yes` (`migrate`) |
| `-y, --yes` | Non-interactive / apply; never prompt |
| `--no-hooks` | Skip wiring the lifecycle hooks; skill + MCP only (`install`) |
| `--force` | Overwrite existing skill files (`install`) |
| `--deep` | Write/read/delete round-trip (`doctor`) |
| `--adapter <name>` | Host framework for `hook`: `claude` / `cursor` / `codex` |
| `--event <name>` | Host hook event for `hook` (else read from the stdin payload) |
| `-h, --help` | Help |
| `-v, --version` | Version |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `LOREKIT_MODE` | select a mode: `off` / `local` / `remote` |
| `LOREKIT_DENY` | comma-separated modes to forbid (deny-wins); e.g. `remote` |
| `LOREKIT_HOME` | home-tier root + config directory (default `~/.lorekit`) |
| `LOREKIT_STORE` | project-tier store directory (default `.lorekit`) |
| `LOREKIT_MCP_URL` / `LOREKIT_ENDPOINT` | endpoint fallback |
| `LOREKIT_TOKEN` | token fallback |
| `NO_COLOR` | disable colored output |

## What the skill does

The installed `lorekit-memory` skill teaches an agent to:

- **Read** scoped lessons at the start of a task, on first navigation into
  unfamiliar code, and before risky operations (narrow-to-broad scope merge).
- **Write** a lesson when something goes wrong — a stuck loop, a repeated
  failure, a gotcha, a near-miss, or a costly wrong assumption — phrased as an
  observation and scoped to the narrowest namespace that fits.

This mirrors the read-on-start / write-on-failure loop of the `aw`
autonomous-workflow agent. See the skill's own `SKILL.md` for the full
protocol.

The **skill** is model-invoked (the agent chooses to use it). For a
**deterministic** guarantee — lessons injected on every session start, a nudge
on every tool failure — use the framework plugins in [`plugins/`](../../plugins/),
which fire the `lorekit hook` engine on host lifecycle events. The skill and
the hooks compose: hooks guarantee the *timing*, the skill supplies the
*authoring judgment*.

## Testing & validating across frameworks

`npm test` (or `node --test test/*.test.mjs`) runs four layers, so you can
validate all three integrations without launching each agent by hand:

1. **Unit** — scope parsing, failure heuristic, lesson formatting, adapter
   mapping/emit.
2. **Engine end-to-end** — spawns the real `lorekit hook` binary for every
   adapter/event, including a mock MCP server that proves the `SessionStart`
   read path injects lessons, plus throttling and bad-input handling.
3. **Cross-framework conformance** — replays payload **fixtures** through the
   binary and asserts the stdout matches each host's documented contract
   (`hookSpecificOutput.additionalContext` for Claude/Codex, `followup_message`
   for Cursor).
4. **Wiring** — runs `claude plugin validate` on the Claude bundle (skipped if
   the `claude` CLI is absent) and structurally validates the Cursor and Codex
   configs; also asserts the vendored skill is in sync with its source.

### Harvesting real fixtures (one run per framework)

Layer 3 ships with documented seed fixtures under `test/fixtures/`. To prove
conformance against what each framework *actually* sends, record real payloads
once by pointing its hook command at the recorder:

```bash
# Temporarily set this env for the hook command in the framework's config,
# then drive the agent through a session start, a failing command, and a stop:
LOREKIT_HOOK_RECORD=/abs/path/to/packages/cli/test/fixtures \
  npx @lorekit/cli hook --adapter claude --event SessionStart
```

Each invocation overwrites `test/fixtures/<adapter>-<event>.json` with the real
payload. Commit the updated fixtures; the conformance tests then run offline
forever. This reduces manual validation to a single capture pass per tool.

> The one thing no offline test can cover is a real model loop (the agent
> actually consuming the injected context). `claude plugin validate` confirms
> the real Claude CLI accepts the wiring; for a true live check, install the
> plugin and start one session per tool.

## Security note

`install` writes your token into `.mcp.json`. Keep that file out of version
control (LoreKit's root `.gitignore` already ignores `.mcp.json`).
