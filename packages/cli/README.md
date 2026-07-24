# @lorekit/cli

Install the **LoreKit shared-memory skill** into a project and run health
checks against your LoreKit MCP server — a small, zero-dependency Node CLI.

LoreKit gives coding agents a shared, persistent memory: lessons one agent
learns are stored centrally and read by every other agent, in every session,
CI included. This CLI wires an agent up to it in two commands.

## Install

```bash
npx @lorekit/cli install
npx @lorekit/cli doctor
```

Requires Node 18+ (for the built-in `fetch`). No dependencies.

## Commands

### `lorekit install`

Scaffolds the `lorekit-memory` skill into `.claude/skills/lorekit-memory/` and
adds (or updates) a `lorekit` server in the project's `.mcp.json`, preserving
any other MCP servers already configured.

```bash
lorekit install \
  --endpoint https://<project-ref>.supabase.co/functions/v1/mcp \
  --token    lk_rw_your_token
```

If run in a TTY without `--endpoint` / `--token`, it prompts for them.
Use `--yes` for non-interactive environments (endpoint required via flag/env).
Use `--force` to overwrite an existing skill copy.

### `lorekit doctor`

Verifies the setup and prints a status report:

- Node runtime is 18+
- the `lorekit-memory` skill is installed
- `.mcp.json` has a `lorekit` server
- endpoint is real (not the `<project-ref>` placeholder)
- token is present and its permission tier (`lk_rw_*` vs `lk_ro_*`)
- the MCP endpoint is reachable and the token is accepted
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

## Options

| Flag | Meaning |
|------|---------|
| `-d, --dir <path>` | Target project root (default: cwd) |
| `-e, --endpoint <url>` | LoreKit MCP endpoint |
| `-t, --token <token>` | LoreKit token |
| `-y, --yes` | Non-interactive; never prompt |
| `--force` | Overwrite existing skill files (`install`) |
| `--deep` | Write/read/delete round-trip (`doctor`) |
| `--adapter <name>` | Host framework for `hook`: `claude` / `cursor` / `codex` |
| `--event <name>` | Host hook event for `hook` (else read from the stdin payload) |
| `-h, --help` | Help |
| `-v, --version` | Version |

## Environment variables

| Variable | Purpose |
|----------|---------|
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
