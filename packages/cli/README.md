# @lorekit/cli

> The fastest way to give your AI coding agent a memory that survives the session.

[![npm](https://img.shields.io/npm/v/@lorekit/cli.svg)](https://www.npmjs.com/package/@lorekit/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)

[LoreKit](https://github.com/mthines/lorekit) gives coding agents a **shared,
persistent memory**: a lesson one agent learns — a migration gotcha, a
flaky-test fix, a costly wrong assumption — is stored once and recalled by every
other agent, in every session, on every machine, CI included.

This is the CLI that connects your agent to it. One command scaffolds
everything — the memory skill, the MCP connection, and the lifecycle hooks — and
it's a zero-dependency Node binary that also runs fully offline against local
markdown files if you never want to sign up for anything.

```bash
npm install -g @lorekit/cli
lorekit install     # wires up the skills, MCP server, and hooks
lorekit doctor      # verify it's all green
```

## Install

The quickstart above uses the **global install — recommended.** You get one
pinned version, the `lorekit` command stays on your `PATH`, and the plugin hooks
(which call `lorekit hook` on every lifecycle event) fire instantly instead of
paying an `npx` resolution cost each time. Upgrade later with
`npm install -g @lorekit/cli@latest`.

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

1. **Skills** (`lorekit-memory` + `lorekit-setup` + `lorekit-groom`) — the model-invoked runtime read/write loop, the self-improvement loop authoring counterpart, and the store-grooming maintenance counterpart.
2. **MCP server** (`lorekit`) — the connection to your lessons, merged into the
   MCP config (preserving any other servers).
3. **Hooks** — the *deterministic* layer: lessons injected on every
   `SessionStart`, and on a tool failure (`PostToolUseFailure`) any lessons that
   look **relevant to that failure** ("you've hit this before") plus a nudge to
   record the fix, and a retrospective nudge on `Stop` — by default only when the
   session actually hit friction (`hooks.stop`). These fire the shared
   `lorekit hook` engine and are merged into `settings.json` (existing hooks
   preserved).

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

#### Claude Code on the web (`--mcp-json`)

Claude Code on the web clones the repo fresh into an ephemeral container, so the
only MCP config it can see is a **committed, repo-root `.mcp.json`** — a global
`~/.claude.json` lives on your machine and never travels there. `--mcp-json`
writes exactly that file, in a **committable** form: it authenticates via a
`${LOREKIT_TOKEN}` reference in an `mcp-remote --header` rather than embedding
the token, so there is no secret in the file.

```bash
lorekit install --mcp-json --yes            # web-ready project .mcp.json
lorekit install --global --mcp-json --yes   # + the machine-wide CLI, skills, hooks
```

Set **`LOREKIT_TOKEN`** as an environment secret in the web UI; the value is
expanded before `mcp-remote` is spawned. `--mcp-json` always writes the
**project-root** file regardless of `--project` / `--global`, and it composes
with either — pair it with `--global` to get the local CLI, skills, and hooks in
`~/.claude` **and** the committable web config in one command. On a `--project`
install it takes over `.mcp.json` with the committable form instead of the
embedded-token one.

**You have to commit the file, and `.mcp.json` is usually git-ignored** (the
default install embeds a token, so LoreKit's own `.gitignore` — and many
projects — ignore it). Un-ignore it before committing (drop the `.mcp.json` line
from `.gitignore`, negate it with `!.mcp.json`, or `git add -f .mcp.json` once);
`install --mcp-json` **warns when the file it wrote is still git-ignored**, so a
fresh web clone silently missing the config is not a mystery. Once `.mcp.json` is
tracked, only run `install --mcp-json` in that repo — a plain `install --project`
would embed a live token in the now-committed file. See the
[Claude Code on the web guide](https://lorekit.io/docs/claude-code-web).

In a TTY it prompts for the scope (and for `--endpoint` / `--token` if missing).
Flags: `--project` / `--global` pick the scope non-interactively; `--yes` runs
non-interactively (endpoint required via flag/env; scope defaults to project);
`--force` overwrites an existing skill copy. Re-running is idempotent — the hook
entries are updated in place, never duplicated, and an event that somehow ended
up with **several** lorekit entries (the marketplace plugin wired on top of a CLI
install, a merged `settings.json`, a hand edit) is collapsed back to exactly one,
reported as `N duplicate(s) removed`.

That repair runs on the hook-wiring step, which a plain `lorekit install` **skips**
on an already-complete install — it short-circuits to the "already installed"
summary instead. So if your hooks are firing twice, run `lorekit install --force`,
or re-state the wiring you want with `lorekit install --hooks all` (or
`--hooks read-only`); both reach the hook step and collapse the duplicates for the
events they wire. `--hooks none` also reaches the hook step, but it is a teardown,
not a repair — it removes every lorekit hook instead of collapsing the copies.

#### Choosing the hooks

The hooks are a separate, explicit choice — they add a `lorekit hook` subprocess
to three Claude Code lifecycle events and write into `settings.json`, so install
asks rather than assuming. **None of them writes memory:** they inject context,
and the write is still the model calling `memory.write`.

| Mode | Wires | What you get |
|------|-------|--------------|
| `all` | `SessionStart`, `PostToolUseFailure`, `Stop` | Lessons injected at session start, plus a nudge on a tool failure and a friction-gated one at end of turn |
| `read-only` | `SessionStart` | Lessons injected; nothing ever nudges |
| `none` | — | Skills + MCP only; memory stays model-invoked |

```bash
lorekit install --hooks read-only   # inject lessons, never nudge
lorekit install --hooks none        # remove any wired hooks
lorekit install --no-hooks --yes    # don't wire new ones; leave existing alone
```

In a TTY the prompt preselects whatever is **already wired**, so re-running
install never resurrects hooks you declined; a genuinely fresh install
preselects `all`. `--yes` / a non-TTY takes that same preselected value without
asking — `all` on a fresh install, otherwise whatever is already wired (`none`
if you previously removed them), and a hand-wired set that matches no preset
keeps exactly that set — no event is added or removed, though a stale hook
command is still refreshed. Pass `--hooks <mode>` to choose explicitly.
`--hooks none` removes hooks that are already there; `--no-hooks` only skips
wiring new ones. `lorekit doctor` reports which events are wired, and in which
scope.

**Replacing a token.** A plain re-run reuses the token already in your config.
An interactive `lorekit install --force` instead asks what to do with it —
**keep**, **replace** (paste a new one), or **remove** — so a revoked token can
be swapped without hand-editing `.mcp.json` / `~/.claude.json`. The stored token
is only ever shown masked (`lk_rw_…ijkl`). Non-interactive runs (`--yes`, or no
TTY) never prompt and keep reusing the stored token; pass `--token` to replace
it in a script.

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
  (`lk_rw_*` / `lk_ro_*` / `lk_wo_*`), that the endpoint is reachable, and —
  the `authentication` check — that the token is **still accepted by the
  server**
- for `off`: a note that memory is disabled
- the git-derived read/write scopes for the current directory

```bash
lorekit doctor            # config + connectivity checks
lorekit doctor --deep     # also does a write → read → delete round-trip (needs lk_rw_*)
```

Exit code is non-zero if any check fails, so it fits CI gates.

**`connectivity` and `authentication` are different questions.** `connectivity`
probes the public `/health` function: it proves the network path and says
nothing about your credential. `authentication` makes one authenticated,
side-effect-free request and reports what the server said about the token
itself:

| Result | Meaning |
| --- | --- |
| `PASS — token accepted` | the token is live (read access confirmed) |
| `PASS — no read permission` | accepted, but it is a write-only `lk_wo_*` token |
| `FAIL — token REJECTED (HTTP 401)` | revoked, deleted, or never valid — every remote read and write is broken |
| `WARN` | rate limited, unreachable, or an inconclusive answer — never reported as "revoked" |

A revoked token is a **failure**, not a warning: fix it by creating a new token
and running `lorekit install --force`, which offers to replace the stored one.

### `lorekit list` (alias `ls`)

Shows the lessons that apply to **where you are** — the scopes `deriveScope`
resolves for the current directory (`project::{name}`, `branch::…`, `repo::…`,
and `global`) — split into two clearly-labelled sections so you can see where
each lesson lives:

- **Offline** — the local two-tier store (`.lorekit/` in the repo + `~/.lorekit/`).
- **Remote** — the hosted LoreKit store, reached over the REST API. When no token/endpoint is configured this
  section is a short note on how to set it up; it is **never an error** (the
  command still exits 0 and shows your offline lessons). A network/server error
  is likewise a per-scope warning, not a crash.

It is read-only — it never writes, deletes, or reveals archived lessons — and it
independently queries both stores regardless of the resolved memory mode. A
`LOREKIT_DENY=remote` (or `local`) ceiling suppresses that section, honoring the
same deny-wins privacy invariant the control model enforces for agents.

```bash
lorekit list                 # both sections, grouped by scope
lorekit ls                   # same, via the alias
lorekit list --scope global  # narrow to a single scope
lorekit list --json          # structured { offline, remote } payload for scripts
```

`--endpoint` / `--token` override the remote connection; `--store` overrides the
local project-tier directory.

### `lorekit search` (alias `grep`)

Full-text search across the same applicable scopes and the same two stores as
`list`, rendered in the same Offline / Remote split. A lesson matches when the
query appears — **case-insensitively, as a literal substring** — in its **key or
value**:

```bash
lorekit search sandbox            # both sections, only the matching lessons
lorekit grep "flaky test"         # same, via the alias
lorekit search migration --scope global
lorekit search build --json       # { query, offline, remote } for scripts
```

The query is matched with a plain substring check, **never compiled as a regex**,
so a term full of metacharacters (`a.*(b)`) matches those characters verbatim —
no injection, no surprises. It is read-only, hides archived lessons, and degrades
the remote section gracefully (an unconfigured remote is a note, not an error;
the command still exits 0). An empty query is a usage error; no matches prints a
friendly "no lessons match" note (exit 0). `--scope` narrows to one scope;
`--endpoint` / `--token` / `--store` behave as in `list`.

### `lorekit show`

Inspect **one** lesson in full — its complete, **untruncated** value plus scope,
key, updated date, tags, and which store(s) it lives in:

```bash
lorekit show global::prefer-guard-clauses
lorekit show repo::acme/widget::build-flags --json
```

If the same `scope::key` exists in **both** the offline and remote stores —
possibly with different values — both are shown and any divergence is flagged.
When it lives in only one store, that copy is shown and the other is noted as
missing. It exits **non-zero** when the key is found in no readable store, so it
fits scripts. `--json` emits the full normalized record(s) and which store each
came from. Both a scope and a key are required (else a usage error).

### Addressing a memory: `<scope::key>`

`show`, `write` and `link` all take a memory the same way, and the single-token
`<scope::key>` form is canonical — it is exactly what `list` and `search` print
and what `write` echoes back, so a key copy-pasted out of any output resolves.
The explicit two-positional form is also accepted, and `--scope` / `--key` name
each half outright:

```bash
lorekit show repo::acme/widget::build-flags        # canonical
lorekit show repo::acme/widget build-flags         # explicit positionals
lorekit show --scope repo::acme/widget --key build-flags
```

The single-token form is split at the **last** `::`, and only when the left side
is itself a **complete valid scope** — so a multi-segment scope stays whole
(`repo::acme/widget::build-flags` is scope `repo::acme/widget`, key
`build-flags`), and a bare `repo::acme/widget` is never mis-read as scope `repo`
plus a bogus key. Because `::` is reserved as the scope separator, a key that
itself contains `::` cannot be written as one token — use `--key` for those:

```bash
lorekit write --scope global --key "loop::aw-lessons" "body"
```

The scope is validated before any store is touched, so a typo is rejected by
name (`invalid scope foo — unrecognized scope type`) instead of surfacing later
as a missing value or, worse, a memory quietly filed under a scope that does not
exist. See [scope format](../../docs/scope-format.md) for the grammar.

### `lorekit stats`

An at-a-glance overview of how many lessons apply to the current directory —
counted **per scope** and **per store** (Offline vs Remote), with per-store and
grand totals, in the same Offline / Remote split as `list`:

```bash
lorekit stats                 # per-scope counts + totals for both stores
lorekit stats --scope global  # narrow to a single scope
lorekit stats --json          # { offline, remote } with per-scope { count } rows
```

Every applicable scope prints a row (a scope with zero lessons still shows `0`,
which is the point of an overview). An unconfigured remote degrades to a short
note — never an error, always exit 0. `--endpoint` / `--token` / `--store`
behave as in `list`. Remote counts reflect what the hosted `memory.list` returns
per scope (the server's default page size); there is no cap-usage `N / limit`
figure because the REST API exposes no total-count or cap endpoint.

### `lorekit scopes`

A **store-wide inventory** of every distinct scope that holds lessons, with a
lesson count per scope, in the same Offline / Remote split as the other read
commands:

```bash
lorekit scopes                 # every scope in the store + a count each
lorekit scopes --scope repo::  # filter to scopes containing a substring
lorekit scopes --json          # { offline, remote } with [{ scope, count }] rows
```

Unlike `list` / `search` / `stats` / `diff` / `tree` — which are all **cwd-scoped**
(they only look at the scopes that resolve for the current directory:
project / branch / repo / global) — `scopes` enumerates **every** scope present in
the store, regardless of the current directory. That's the whole point: it lets
you see all the scopes you have lessons in, anywhere. Scopes are grouped by type
(global → project → repo → branch), then alphabetically; each store shows a
per-store total and scope count.

`--scope <s>` is a **substring filter** over the inventory (not a single-scope
selector — an inventory of one scope would be pointless).

**Offline enumeration is exact.** It walks the local two-tier store and reads
each lesson file's frontmatter `scope` string directly, rather than reverse-
mapping the on-disk directory layout (which is lossy for `project::{name}`,
stored by basename only) — so every scope is reconstructed verbatim. Lessons
present in both tiers are counted once (project shadows home, the same merge
`list` uses); archived lessons are excluded.

**Remote enumeration is exact too.** `RemoteStore.listScopes()` calls
`GET /memories/scopes`, which aggregates one `{ scope, count }` row per scope in
Postgres (never a truncatable `select('scope')` plus a client-side dedupe), so
the Remote section is a real inventory rendered through the same helpers as the
Offline one. A denied, unconfigured, unreachable, or erroring remote degrades to
a short, accurate note (network error / HTTP status — never a faked listing) at
exit 0. `--endpoint` / `--token` / `--store` behave as in `list`.

### `lorekit diff`

Compare the **offline** and **remote** stores for the applicable scopes and
report where they diverge, grouped by scope:

```bash
lorekit diff                  # local-only / remote-only / conflicting, per scope
lorekit diff --scope global   # narrow to a single scope
lorekit diff --json           # { comparable, totals, groups[] } for scripts
```

Three groups: **local-only** (key present offline, absent remote), **remote-only**
(absent offline, present remote), and **conflicting** (same `scope::key` in both,
but the value or tags differ). A diff needs **both** stores readable — if the
remote is unconfigured (or a store is denied), a meaningful diff is impossible,
so `diff` prints a clear note (`comparable: false` in `--json`) and exits 0
rather than crashing. `--endpoint` / `--token` / `--store` behave as in `list`.

### `lorekit tree` (alias `resolve`)

Show the scopes the hooks actually **inject** — project → branch → repo →
global, in precedence order (most-specific first) — as a resolution hierarchy,
and mark for any key present at more than one scope which scope's lesson **wins**
and which are **shadowed**:

```bash
lorekit tree                  # the injected hierarchy with ✓ winning / ↳ shadowed marks
lorekit tree --scope global   # narrow to a single scope
lorekit tree --json           # per-entry { winning, shadowedBy } + a winners[] list
```

This mirrors the SessionStart hook's resolution **exactly**: it reads the scopes
in `readOrder` (project → branch → repo → global) and keeps the first value seen
per key, so a more-specific scope overrides a broader scope's same-key lesson. It
answers "which lesson actually applies here, and what is being overridden?". The
`project::` scope **is** part of the injected set (project is the most-specific
scope), so `tree`, the hooks, and every read command's `scopeList` now share one
ordering. Each store is resolved independently, in the same Offline / Remote split.

### `lorekit lint`

Flag low-quality lessons across the applicable scopes and both stores. Each
finding names the rule it violated:

```bash
lorekit lint                  # findings grouped by scope; exits non-zero if any
lorekit lint --scope global   # narrow to a single scope
lorekit lint --json           # { total, offline, remote } structured findings
```

Rules: **empty-value** (blank/whitespace-only body), **short-value** (a non-empty
body below a small length threshold), **untrimmed-value** (real content with
surrounding whitespace), **empty-key** (blank key), **volatile-key** (the key
carries a per-sighting identifier — a run of 6+ digits such as a GitHub comment
id, or a `pr<n>` / `issue<n>` segment — so it never collides, never dedups, and
freezes `seen_count` at 1), and **malformed-scope** (e.g.
a single `:` where `::` is expected). `lint` **exits non-zero (1) when any issue
is found**, so it is usable as a CI gate (`lorekit lint || exit 1`); a clean run —
or one where only a store is unavailable — exits 0. The pure rule predicates live
in `lessons-view.mjs` and are unit-tested one rule at a time.

### `lorekit dedupe`

Find likely-duplicate lessons and group them into clusters — per store, across
the applicable scopes:

```bash
lorekit dedupe                    # clusters of near-duplicate lessons per store
lorekit dedupe --threshold 0.6    # loosen the similarity cutoff (default 0.8)
lorekit dedupe --json             # { threshold, offline, remote } clusters + signal
```

The similarity signal is a zero-dependency **heuristic** — Jaccard overlap of
lowercased word tokens, **not** a semantic/embedding measure — so it surfaces
candidates for a human to review and can both miss paraphrases and group
coincidental overlaps. Any pair scoring at or above `--threshold` links (transitively)
into one cluster; only clusters of 2+ members are reported, each with a similarity
range. Cross-**store** divergence is `diff`'s job; `dedupe` looks within a store.

### `lorekit link` (alias `url`)

Print a shareable **dashboard deep-link URL** to stdout — nothing else, so it
pipes straight into your clipboard or a PR/Slack message:

```bash
lorekit link                              # link to the current repo/branch context
lorekit link | pbcopy                     # copy it straight to the clipboard
lorekit link global                       # the Explorer filtered to global scope
lorekit link repo::owner/repo prefer-guards   # open one lesson's detail sheet
lorekit link global::prefer-guards --json     # { url, surface, base, params }
lorekit url --q "flaky test" --owner personal # search + ownership filter
lorekit link global --tags "perf,ci"          # Explorer filtered to labels
```

With no arguments it links to the cwd's **most-specific scope** ("share what I'm
looking at"). A single argument that is a valid scope — including a `repo::…` or
`branch::…::…` scope — links to the Explorer filtered to that scope; a scope
**and** key (two positionals, or the `scope::key` shorthand) links straight to
that lesson's detail sheet. It sets **both** the `lesson` param (which opens the
sheet) and `scope` — not because scope is needed to find the lesson (the sidebar
reads one unfiltered recent set), but so the Explorer list *behind* the sheet is
filtered to the lesson's own scope. Filter flags mirror the Explorer: `--q`
(search), `--owner <all|personal|orgId>`, `--tags <a,b,c>` (label filter, AND
across labels; comma-separated or a JSON array), `--range`/`--from`/`--to`,
`--archived`, `--view <scope|time>`.

Every param is `encodeURIComponent(JSON.stringify(value))` — the exact inverse of
how the dashboard's `useUrlState` reads it back (`JSON.parse`, falling back to the
default on failure). A raw `?scope=global` would silently mean "all scopes", so
the link **must** be JSON-encoded to open the intended view. `--base <url>` (or
`LOREKIT_APP_URL`) overrides the dashboard host for self-hosted setups; the
default is `https://lorekit.io`. Read-only and network-free — it derives scopes
from git and builds a URL, never touching a store.

The **read commands take a `--link` flag** that short-circuits to print the
equivalent deep link, reusing the same builder: `show <scope::key> --link` → the
lesson link, `search foo --link` → `/lore?q="foo"` (+ scope), and `list --link` /
`tree --link` → the Explorer filtered to the **most-specific applicable scope**
(or `--scope` when given) — the dashboard filters one scope at a time, so the
multi-scope `list`/`tree` view maps to its primary scope. (The same JSON-encoded
links now back the hooks' write-confirmation and retrospective nudges.)

### `lorekit hook`

The **shared hook engine** behind the Claude Code / Cursor / Codex plugins.
It is not run by hand — the plugins wire it into their hook config. It reads
the host framework's JSON on stdin and prints that host's injection format on
stdout (lessons at session start; relevant lessons plus a write-nudge on a tool
failure; a retrospective nudge at end of turn), always exiting 0 so it can never
block the host agent.

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
| `remote` | the hosted LoreKit API (REST) | The shared, cross-machine backend. Reads stay silent until an endpoint + token are configured. This is the default. |

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

Both files share this schema — all fields optional:

```jsonc
// .lorekit.json  (repo root — safe to commit, no secrets)
// ~/.lorekit/config.json  (user/machine — personal overrides, not committed)
{
  // ── Mode & store ───────────────────────────────────────────────────────────
  "mode": "local",         // off | local | remote
  "store": ".lorekit",     // project-tier store path (relative to root, or absolute)
  "deny": ["remote"],      // forbid modes outright — deny always wins, union across layers

  // ── Connection (repo config only — no token, safe to commit) ───────────────
  "mcp.endpoint": "https://<ref>.supabase.co/functions/v1/mcp",
                           // committable MCP URL without token; token still comes
                           // from .mcp.json or LOREKIT_TOKEN env var

  // ── Write behaviour ────────────────────────────────────────────────────────
  "tags.default": ["team", "project::my-project"],
                           // tags appended to every memory.write from this repo/user
                           // both layers merged: repo tags first, then user tags

  "ttl.default": 90,
                           // days until a write that named no TTL expires
                           // repo wins over user (a scalar policy cannot merge)
                           // omit for the historical behaviour: memories are permanent

  "scope.defaults": {
    "repo::owner/name":     { "tags": ["team"] },
    "branch::owner/name::": { "tags": ["ephemeral"], "ttl_days": 14 },
    "global":               { "ttl_days": null }
  },
                           // per-scope tag and TTL defaults applied to writes whose scope
                           // starts with the key; matched by prefix (no wildcards needed)
                           // repo config only — this is a team-level write policy
                           // ttl_days: null means "permanent", overriding ttl.default

  // ── Hook behaviour ─────────────────────────────────────────────────────────
  "hooks.disabled": ["Stop"],
                           // suppress specific hook events; union across layers
                           // values: "SessionStart" | "PostToolUseFailure" | "Stop"

  "hooks.stop": "friction",
                           // gate the end-of-turn retrospective nudge:
                           //   "friction" (default) — only nudge once/session when the
                           //     session hit friction (a failed tool call or a stuck
                           //     retry loop, read from the transcript); silent otherwise
                           //   "always"             — nudge once per session regardless
                           //   "off"                — never (same effect as disabling Stop)
                           // repo wins over user
                           // (friction is detectable only on Claude Code, which exposes a
                           //  transcript; on Cursor/Codex there is none, so "friction"
                           //  falls back to firing so no lesson is silently lost)

  "hooks.sessionStart": "hybrid",
                           // shape of the block injected at session start:
                           //   "hybrid" (default) — fill the character budget with the
                           //     highest-ranked memories, then add one line naming what
                           //     was left out and where it lives
                           //   "index"            — the same list, no trailing map
                           //                        (truncation is silent)
                           //   "map"              — lead with the scope map plus the
                           //                        three most salient memories
                           // repo wins over user; an unrecognised value is ignored and the
                           // next layer is tried, so a mistyped repo value falls through to
                           // the user layer before defaulting to hybrid

  "hooks.sessionStart.maxChars": 1500,
                           // character budget for that block (default 1500, ~375 tokens)
                           // bounded to 200–20000; an out-of-range value is CLAMPED, not
                           // rejected — a small number means "keep it short", and honouring
                           // the floor is closer to that intent than restoring the default
                           // repo wins over user, and a declared-but-unparseable repo value
                           // still claims the decision (a typo'd project policy degrades to
                           // the default rather than silently becoming a per-machine one)
                           // memories are RANKED before the budget is spent, so what
                           // survives is the most-recurring and most-recent, not the newest

  "hooks.adapter": "claude",
                           // explicit adapter when auto-detection is ambiguous
                           // values: "claude" | "cursor" | "codex"
                           // repo wins over user

  "hooks.instructions": {
    "SessionStart":        "Focus on migration safety. Treat any lesson tagged 'migration' as high-priority.",
    "PostToolUseFailure":  "When recording a failure, always include the exact command and exit code.",
    "Stop":                null
  },
                           // per-event custom text appended to the hook output.
                           // both layers merged: repo instructions first, then user.
                           // null (or absent key) means no extra instruction for that event.
                           // values: string | null  (keys: "SessionStart" | "PostToolUseFailure" | "Stop")

  // ── Telemetry ──────────────────────────────────────────────────────────────
  "telemetry.disabled": true,
                           // team-level opt-out for orgs with a no-telemetry policy
                           // env LOREKIT_TELEMETRY=0 always wins if set

  // ── Dedupe threshold ───────────────────────────────────────────────────────
  "dedupe.threshold": 0.8  // Jaccard similarity cutoff for `lorekit dedupe`
                           // --threshold flag wins when passed explicitly
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

### Default TTL

A memory with no TTL never expires. That is still the out-of-the-box behaviour,
and it is the right default for a lesson someone deliberately curated — but it is
the wrong one for the steady drip of observations a hook nudges an agent into
writing at the end of every run. `ttl.default` and
`scope.defaults.<prefix>.ttl_days` let a repo say how long its lore stays fresh.

**Precedence, most specific first:**

| # | Source | Wins because |
| - | ------ | ------------ |
| 1 | `--ttl-days` / `--clear-ttl` | An explicit flag is the caller's assertion about this one memory. `--clear-ttl` is how you keep something forever in a repo that defaults to expiring. |
| 2 | The longest matching `scope.defaults` prefix with a `ttl_days` key | The most specific scope is the one the config author meant. `null` there means permanent. |
| 3 | `ttl.default` | The repo-wide (or user-wide) fallback. |
| 4 | No expiry | Nothing configured. |

Prefix matching is `::`-delimited, so `branch::` covers every branch scope while
`repo::owner` does **not** cover `repo::owner/name` — `owner/name` is a single
segment. Tags from `scope.defaults` union across every matching prefix; a TTL
cannot, so exactly one entry wins.

A configured TTL that is out of range (or not a number) is **ignored** — the
write succeeds with no expiry rather than failing. Config is ambient state that
must never break an unrelated write; `--ttl-days 999`, by contrast, is a usage
error, because you typed it. `lorekit write` names the source in its output:

```
  expires in 90 days (from config)
```

**Two limits worth knowing.** First, this is a **client-side** default: the
hosted `memory.write` contract is unchanged, so omitting `ttl_*` there still
means permanent. An agent talking straight to the MCP endpoint never sees your
config file. Second, a **hook cannot apply it** — hooks only read lore and emit
text; the write happens afterwards, in the agent's context. So the nudges instead
*advise* the resolved number:

```
LoreKit: hit any friction worth remembering … Set ttl_days: 90 (this scope's
configured default) unless the lesson is durable enough to keep forever.
```

That is advice, not enforcement. An agent that ignores it writes a permanent
memory, exactly as before.

**Refresh on update is free.** `memory_write` refreshes `expires_at` only when a
`ttl_*` is supplied, so re-writing the same `scope`+`key` with the default
applied slides the window forward — a lesson that keeps recurring keeps living,
and one nobody has seen in 90 days decays. Expired rows are swept nightly, which
also returns their headroom against the plan's memory cap.

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
| `--hooks <mode>` | Lifecycle hooks to wire: `all` / `read-only` / `none` (`install`; `none` removes any already wired) |
| `--no-hooks` | Skip wiring the lifecycle hooks; skills + MCP only. Leaves already-wired hooks alone (`install`) |
| `--mcp-json` | Also write a committable project `.mcp.json` (auth via `${LOREKIT_TOKEN}`, no embedded token) for Claude Code on the web (`install`) |
| `--force` | Overwrite existing skill files (`install`) |
| `--deep` | Write/read/delete round-trip (`doctor`) |
| `--json` | Machine-readable output (`list` / `search` / `show` / `stats` / `scopes` / `diff` / `tree` / `lint` / `dedupe` / `link`) |
| `--scope <scope>` | Restrict to a single scope (`list` / `search` / `stats` / `diff` / `tree` / `lint` / `dedupe` / `link`; default: all applicable). For `scopes` it is a **substring filter** over the inventory. On `show` / `write` it **names** the scope, overriding the positional |
| `--key <key>` | Name the key outright (`show` / `write` / `link`) — the way to address a key that itself contains `::` |
| `--link` | Print the equivalent dashboard deep-link URL instead of running (`show` / `search` / `list` / `tree`) |
| `--base <url>` | Dashboard base URL for deep links (`link` / `--link`; else `LOREKIT_APP_URL`, default `https://lorekit.io`) |
| `--threshold <0..1>` | Duplicate-similarity cutoff (`dedupe`; default `0.8`) |
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
| `LOREKIT_TELEMETRY` | set to `0` / `off` / `false` to disable usage telemetry |
| `DO_NOT_TRACK` | `1` also disables usage telemetry (cross-vendor standard) |
| `LOREKIT_TELEMETRY_TOKEN` | bearer token for telemetry export (overrides the baked-in default) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` | override the telemetry OTLP endpoint / headers |

## What the skills do

`install` scaffolds three skills:

The **`lorekit-memory`** skill teaches an agent to:

- **Read** scoped lessons at the start of a task, on first navigation into
  unfamiliar code, and before risky operations (narrow-to-broad scope merge).
- **Write** a lesson when something goes wrong — a stuck loop, a repeated
  failure, a gotcha, a near-miss, or a costly wrong assumption — phrased as an
  observation and scoped to the narrowest namespace that fits.

This mirrors the read-on-start / write-on-failure loop of the `aw`
autonomous-workflow agent. See the skill's own `SKILL.md` for the full
protocol.

The **`lorekit-setup`** skill is the authoring counterpart: it teaches an agent
to wire a self-improvement loop into one of *your own* skills or workflows — the
two-tier model, the lesson bucket convention, and the entrenchment guards. See
its `SKILL.md` and `rules/self-improvement-loops.md`.

The **`lorekit-groom`** skill is the maintenance counterpart: it teaches an agent
to run a grooming pass over an accumulated store — survey (`stats` / `scopes`),
lint, dedupe & merge near-duplicates, set expiry (TTL) on time-bound lessons, and
prune or archive obsolete ones. It always analyses read-only and proposes a plan
before mutating (archive is preferred over hard-delete), because the store is
shared and a merge or delete is permanent for every agent. See its `SKILL.md`,
`rules/grooming-pass.md`, and `references/merge-and-expiry.md`.

The **skills** are model-invoked (the agent chooses to use them). For a
**deterministic** guarantee — lessons injected on every session start, a nudge
on every tool failure — use the framework plugins in [`plugins/`](../../plugins/),
which fire the `lorekit hook` engine on host lifecycle events. The skills and
the hooks compose: hooks guarantee the *timing*, the skills supply the
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

## Usage telemetry

The human-facing commands (`install`, `uninstall`, `doctor`, `list`, `search`,
`show`, `stats`, `scopes`, `diff`, `migrate`)
emit one OpenTelemetry span + one counter point per run so the maintainers can see which
commands people use. It is zero-dependency (OTLP/JSON over `fetch`, no SDK) and
deliberately narrow — it carries only the command name, a bounded set of boolean
flags (`--global`, `--deep`, …), the CLI/runtime/OS identity, and the outcome.
**No path, token, endpoint, repo, or scope is ever sent.** The `hook` and `mcp`
commands are never instrumented.

Opt out any time with `LOREKIT_TELEMETRY=0` (or `off` / `false` / `no`) or the
cross-vendor `DO_NOT_TRACK=1`. Point it at your own collector with
`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`, or set just the
bearer via `LOREKIT_TELEMETRY_TOKEN`. Export is a no-op when no token is
configured. The published package's default token is injected from a CI secret
at release time and is never committed to git. See
[docs/otel.md](../../docs/otel.md) for the attribute list and setup.

## Security note

`install` writes your token into `.mcp.json`. Keep that file out of version
control (LoreKit's root `.gitignore` already ignores `.mcp.json`).

The **one exception is `install --mcp-json`**: that file authenticates via a
`${LOREKIT_TOKEN}` reference instead of an embedded token, so it holds no secret
and **is** meant to be committed (that is how Claude Code on the web reads it
after a fresh clone). You'll need to un-ignore `.mcp.json` first, since it is
normally git-ignored for the embedded-token reason above. The token itself comes
from the `LOREKIT_TOKEN` environment variable at runtime — set it as an
environment secret, never commit it — and once the file is tracked, keep using
`--mcp-json` so a later plain install never writes a token into it.
