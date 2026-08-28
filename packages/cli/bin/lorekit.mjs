#!/usr/bin/env node
// LoreKit CLI — install the shared-memory skill and run health checks.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { parseArgs, log, err, c } from '../src/shared/util.mjs';
// Commands, their handlers, aliases and dispatch properties all come from one
// registry — see ../src/commands.mjs for why membership lives there and the
// help prose stays here.
import { COMMANDS_BY_NAME, STRICT_FLAG_COMMANDS, COMMAND_ALIASES } from '../src/commands.mjs';
// Catalog-derived, so the default this help PROMISES is the one the server
// applies — see src/surfaces.generated.mjs.
import { PURGE_RETENTION_DAYS_DEFAULT } from '../src/surfaces.generated.mjs';
import { traceCommand, meterCommand } from '../src/telemetry/telemetry.mjs';
import { loadDotEnv } from '../src/shared/dotenv.mjs';

// Read the version from package.json so it always matches the published
// package — release-please bumps package.json, and this tracks it for free.
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const HELP = `${c.bold('lorekit')} — shared persistent memory for coding agents

${c.bold('Usage')}
  npx @lorekit/cli <command> [options]

${c.bold('Commands')}
  install     Scaffold the lorekit-memory + lorekit-setup skills, wire the
              LoreKit MCP server, and install the deterministic hooks (memories
              on SessionStart, a nudge on tool failure + at Stop). Prompts to
              install for this project (.claude) or globally for every project
              (~/.claude); --project / --global choose non-interactively.
              Also prompts whether to wire the hooks (all / read-only /
              none); --hooks <mode> chooses non-interactively and --no-hooks
              skips them (skills stay model-invoked only). --mcp-json also
              writes a committable project .mcp.json for Claude Code on the web.
  uninstall   Reverse install: remove the lorekit-memory + lorekit-setup skills,
              the MCP server entry, and the lifecycle hooks for the chosen scope. Surgical —
              other servers, hooks, and settings are left untouched. Prompts
              project vs global; --project / --global choose non-interactively.
  doctor      Verify the skill install, remote connectivity, token, and scope.
  list (ls)   List the memories that apply to the current directory, split into
              an Offline section (local .lorekit/ + ~/.lorekit/) and a Remote
              section (the hosted LoreKit API). Groups by scope (project/branch/repo/global).
              --json for scripting, --scope <s> to narrow.
  search      Full-text search the applicable memories across both stores and all
    (grep)    scopes (case-insensitive, literal substring over key + value),
              rendered in the same Offline/Remote split. --json, --scope <s>.
  show        Inspect one memory in full: its complete value, scope, key, updated
              date, tags, and which store(s) it lives in (noting any divergence
              when it is in both). Takes show <scope::key> — the format list and
              search print — or the explicit show <scope> <key>. --json.
  write       Create or update a memory, addressed the same <scope::key> way.
              Value is a positional, --value flag, or piped stdin. Writes to the
              remote store when configured, falling back to local. --local /
              --remote to force.
  stats       Count the applicable memories per scope and per store (offline vs
              remote), with per-store and grand totals, in the same Offline/
              Remote split. --json, --scope <s>.
  scopes      Store-wide inventory of EVERY distinct scope that holds memories,
              with a memory count per scope — not cwd-scoped like the commands
              above (it lists scopes anywhere in the store). Offline is exact;
              the remote can't enumerate scopes (honest note). --json, --scope <s>.
  diff        Compare the offline and remote stores for the applicable scopes and
              report divergence: local-only, remote-only, and conflicting keys
              (grouped by scope). Needs both stores readable. --json, --scope <s>.
  tree        Show the injected scopes (project → branch → repo → global) as a precedence
    (resolve) hierarchy and mark, per key, which scope's memory WINS and which are
              shadowed — the real hook-resolution order. --json, --scope <s>.
  lint        Flag low-quality memories (empty/short/untrimmed value, empty key,
              volatile key, malformed scope) across the applicable scopes and
              both stores. Exits non-zero when issues are found (CI gate).
              --json, --scope <s>.
  dedupe      Find likely-duplicate memories via a zero-dep word-overlap HEURISTIC
              (Jaccard >= threshold, not semantic), grouped into clusters per
              store. --json, --scope <s>, --threshold <0..1>.
  obligations Check a changed-file set against the Surface-Partner Map: known,
              path-keyed file partnerships (a mirrored module, a doc that
              copies a claim, a generated artifact) mined from existing CI
              guards. Prints each matched partnership's obliged partner
              files/actions and flags any partner NOT in the given set.
              Cwd-independent — matches path strings, never reads the FS.
              --files <path>..., positionals, or stdin (newline-separated).
              --json, --strict (exit non-zero on any unmet obligation).
  link (url)  Print a shareable dashboard deep-link URL for the current context,
              a scope, or a specific lesson (opens its detail sheet). No args
              links to the cwd's most-specific scope. Filter flags mirror the
              Explorer (--q / --owner / --tags / --range / --archived);
              --base or LOREKIT_APP_URL override the dashboard host. --json. Pipe it:
              lorekit link | pbcopy.
  purge       Permanently delete ARCHIVED memories older than --retention-days
              (default ${PURGE_RETENTION_DAYS_DEFAULT}, range 1-365). Remote only, account-wide and
              IRREVERSIBLE: prompts for confirmation, and requires --yes when
              there is no terminal to prompt (a pipe, CI, or --json). A token
              restricted to specific scopes is refused by the server.
  purge-expired
              Permanently delete every TTL-EXPIRED memory. Same posture as
              purge: remote only, account-wide, irreversible, --yes required
              non-interactively. Takes no options.
  groom       Preview (default) or --run a retention sweep: --policy-id <id> or
              --scope <s> [+ --min-age-days/--unseen-days/--max-seen-count].
              Remote only. --run soft-archives matches (recoverable via
              restore); prompts for confirmation, --yes to skip. --json.
  policy      Manage saved retention rules: list / create / update / delete.
              policy create --scope <s> --name <n> [--mode review|auto]
              [--enabled] [conditions...]. policy update <id> [fields...].
              policy delete <id> [--yes]. Remote only. --json.
  protect     Mark a memory protected — excluded from every grooming sweep
              regardless of policy. protect <scope::key> [--off] to unprotect.
              Remote only. --json.
  pin / unpin Shorthand for protect / protect --off. Remote only. --json.
  bootstrap   Apply the BYOD schema to a user-supplied Supabase database.
              Only needed when using LOREKIT_STORAGE_URL / LOREKIT_STORAGE_ANON_KEY.
              See docs/byod.md for setup instructions.
  migrate     Relocate a LoreKit-format local store into the current layout,
              or push it up to the hosted store with --to remote.
              Dry-run by default; pass --yes to apply. Idempotent.
  hook        Hook engine for Claude Code / Cursor / Codex. Reads the host's
              JSON on stdin and injects memories or a retrospective nudge.
              Not run by hand — wired into a plugin's hook config.
  mcp         Local stdio MCP server. Exposes the memory.* tools backed by the
              resolved store (local .lorekit/ offline, or remote passthrough) so
              .mcp.json can point at the CLI instead of mcp-remote. Speaks
              JSON-RPC on stdin/stdout — not run by hand.
  completion  Print a shell completion script for zsh or fish. Pipe it to your
              shell's completion dir, or let \`install --completions\` wire it for
              you. Completes commands, per-command flags, and — from the local
              store — scopes and scope::key addresses.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --project           Install into this project: .claude/skills + .mcp.json (default)
      --global            Install for every project: ~/.claude/skills + ~/.claude.json
  -e, --endpoint <url>    LoreKit MCP endpoint
  -t, --token <token>     LoreKit token (lk_rw_* to allow writes, lk_ro_* read-only)
      --mode <mode>       Memory mode: off | local | remote (doctor override)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --json              Machine-readable output (list / search / show / stats / scopes / diff / tree / lint / dedupe / obligations / link)
      --scope <scope>     Restrict to a single scope; a substring filter for scopes (list / search / stats / scopes / diff / tree / lint / dedupe / link)
                          On show / write it NAMES the scope, overriding the positional
      --files <path>...   Changed files to check (obligations); also accepted as positionals or newline-separated stdin
      --strict            Exit non-zero on any unmet obligation (obligations)
      --key <key>         Name the key explicitly (show / write / link) — the way to
                          address a key that itself contains \`::\`
      --link              Print the equivalent dashboard deep-link URL instead of running (show / search / list / tree)
      --base <url>        Dashboard base URL for deep links (link / --link; else LOREKIT_APP_URL, default https://lorekit.io)
      --threshold <0..1>  Duplicate-similarity cutoff (dedupe; default 0.8)
      --retention-days <1..365>
                          Only purge archived memories older than this (purge;
                          default ${PURGE_RETENTION_DAYS_DEFAULT})
      --from <path>       Source store to migrate from (migrate)
      --to <dest>         Migration destination: home | project | remote (migrate;
                          default routes each entry by scope across the local tiers)
      --apply             Apply the migration (alias of --yes) (migrate)
  -y, --yes               Non-interactive / apply; never prompt
      --hooks <mode>      Lifecycle hooks to wire: all | read-only | none (install)
      --no-hooks          Skip wiring the lifecycle hooks (install)
      --mcp-json          Also write a committable project .mcp.json for Claude Code on
                          the web — auth via \${LOREKIT_TOKEN}, no embedded secret (install)
      --completions <s>   Install shell completion: auto | zsh | fish | none (install)
      --force             Overwrite existing skill files (install)
      --deep              Do a write→read→delete round-trip (doctor)
      --telemetry         Verify the OTLP export credential works (doctor)
      --adapter <name>    Host framework for hook: claude | cursor | codex
      --event <name>      Host hook event (else read from stdin payload)
  -h, --help              Show this help
  -v, --version           Print the version

${c.bold('Environment')}
  LOREKIT_MODE                         off | local | remote (select a mode)
  LOREKIT_DENY                         comma list of forbidden modes (deny-wins)
  LOREKIT_HOME                         home-tier root + config dir (default ~/.lorekit)
  LOREKIT_STORE                        project-tier store directory (default .lorekit)
  LOREKIT_MCP_URL / LOREKIT_ENDPOINT   endpoint fallback
  LOREKIT_TOKEN                        token fallback
  NO_COLOR                             disable colored output
  LOREKIT_TELEMETRY / DO_NOT_TRACK     set to 0/off (or DO_NOT_TRACK=1) to opt
                                       out of anonymous command-usage telemetry

A ${c.cyan('.env')} file in the current directory is loaded automatically. Real
environment variables take precedence, so the file is a fallback.

${c.bold('Examples')}
  npx @lorekit/cli install --endpoint https://ref.supabase.co/functions/v1/mcp --token lk_rw_xxx
  npx @lorekit/cli install --global    # set up memory for every project (~/.claude)
  npx @lorekit/cli uninstall --global  # tear that global setup back down
  npx @lorekit/cli doctor --deep
  npx @lorekit/cli migrate --from .lore                 # preview a rename
  npx @lorekit/cli migrate --from .lore --to project --yes
  npx @lorekit/cli migrate --from .lorekit --to remote --yes  # push local lore up

Run ${c.cyan('lorekit <command> --help')} for command-specific options.
`;

// Per-command help. Keyed by command; `lorekit <command> --help` prints the
// focused entry instead of the full top-level HELP, so a user only sees the
// flags that actually apply to what they're running.
const COMMAND_HELP = {
  install: `${c.bold('lorekit install')} — scaffold the skills, wire the MCP server, install the hooks

${c.bold('Usage')}
  npx @lorekit/cli install [options]

Scaffolds the lorekit-memory (runtime read/write) and lorekit-setup (loop
authoring) skills, adds the LoreKit MCP server, and asks whether to wire the
deterministic hooks. The hooks inject context — they never write memory
themselves; the write is still the model calling memory.write.

${c.bold('Hook modes')}
  all         SessionStart (inject lessons) + PostToolUseFailure and Stop
              (nudge you to record one). Preselected on a fresh install.
  read-only   SessionStart only — lessons are injected, nothing ever nudges.
  none        No hooks; the skills stay model-invoked only.

An interactive run preselects whatever is already wired, so re-running install
never resurrects hooks you declined. Answering "No hooks" (or --hooks none)
REMOVES hooks that are already there; --no-hooks only skips wiring new ones.

${c.bold('Claude Code on the web')}
Add --mcp-json to write a committable project .mcp.json (repo root) that Claude
Code on the web can see after a fresh clone. It authenticates via a
\${LOREKIT_TOKEN} reference in an mcp-remote --header — NOT an embedded token —
so the file is safe to commit; set LOREKIT_TOKEN as an environment secret in the
web UI. Pair it with --global to get the local CLI, skills, and hooks in
~/.claude AND the committable web config in one command.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --project           Install into this project: .claude/skills + .mcp.json (default)
      --global            Install for every project: ~/.claude/skills + ~/.claude.json
  -e, --endpoint <url>    LoreKit MCP endpoint (else LOREKIT_MCP_URL)
  -t, --token <token>     LoreKit token: lk_rw_* read+write, lk_ro_* read-only, lk_wo_* write-only
      --hooks <mode>      Wire the lifecycle hooks: all | read-only | none
      --no-hooks          Skip wiring the lifecycle hooks (leaves existing ones alone)
      --mcp-json          Also write a committable project .mcp.json (\${LOREKIT_TOKEN} auth)
                          for Claude Code on the web — always the repo-root file
      --completions <s>   Install shell completion: auto (detect \$SHELL) | zsh | fish | none.
                          Interactive runs prompt; non-interactive ones skip it unless
                          this flag is passed. zsh adds a guarded block to ~/.zshrc; fish
                          drops a file in ~/.config/fish/completions (auto-loaded).
      --force             Overwrite existing skill files
  -y, --yes               Non-interactive; never prompt (defaults to --project, and to the
                          already-wired hooks — all on a fresh install)

${c.bold('Examples')}
  npx @lorekit/cli install --endpoint https://ref.supabase.co/functions/v1/mcp --token lk_rw_xxx
  npx @lorekit/cli install --global
  npx @lorekit/cli install --mcp-json --yes          # web-ready project .mcp.json
  npx @lorekit/cli install --global --mcp-json --yes # local CLI + committable web config
  npx @lorekit/cli install --hooks read-only --yes
  npx @lorekit/cli install --no-hooks --yes
  npx @lorekit/cli install --completions auto --yes  # detect \$SHELL and wire completion
`,
  uninstall: `${c.bold('lorekit uninstall')} — reverse install for the chosen scope

${c.bold('Usage')}
  npx @lorekit/cli uninstall [options]

Removes the lorekit-memory and lorekit-setup skills, the MCP server entry, and
the lifecycle hooks. Surgical — other servers, hooks, and settings are left untouched.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --project           Uninstall from this project (default)
      --global            Uninstall the global (~/.claude) setup
  -y, --yes               Non-interactive; never prompt

${c.bold('Examples')}
  npx @lorekit/cli uninstall --global
  npx @lorekit/cli uninstall --project --yes
`,
  doctor: `${c.bold('lorekit doctor')} — verify the skill install and the resolved memory backend

${c.bold('Usage')}
  npx @lorekit/cli doctor [options]

Checks the node runtime, skill install, resolved memory mode, remote connectivity,
token, and scope.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --mode <mode>       Override the resolved mode: off | local | remote
  -e, --endpoint <url>    Endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --deep              Do a write→read→delete round-trip
      --telemetry         Focused run: skip the other checks, POST a probe
                          span to the OTLP endpoint, and FAIL if the Dash0
                          ingesting token is missing or rejected. Without it,
                          telemetry is reported as info only.

${c.bold('Examples')}
  npx @lorekit/cli doctor
  npx @lorekit/cli doctor --deep
  npx @lorekit/cli doctor --telemetry
  npx @lorekit/cli doctor --mode local
`,
  list: `${c.bold('lorekit list')} — list the memories that apply to the current directory ${c.dim('(alias: ls)')}

${c.bold('Usage')}
  npx @lorekit/cli list [options]

Shows the memories for the scopes that resolve for the current directory
(project/branch/repo/global), split into an Offline section (the local
.lorekit/ + ~/.lorekit/ two-tier store) and a Remote section (the hosted LoreKit
API). When no remote token/endpoint is configured the Remote section is a
short note on how to set it up — never an error.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --json              Machine-readable output
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --link              Print the Explorer deep-link for the most-specific scope (or --scope) instead of running (with --base / --json)

${c.bold('Examples')}
  npx @lorekit/cli list
  npx @lorekit/cli list --json
  npx @lorekit/cli list --scope global
  npx @lorekit/cli list --scope global --link
`,
  search: `${c.bold('lorekit search')} — full-text search the applicable memories ${c.dim('(alias: grep)')}

${c.bold('Usage')}
  npx @lorekit/cli search <query> [options]

Searches every memory for the current directory's scopes (project/branch/repo/
global) across both stores, matching the query case-insensitively as a LITERAL
substring of a memory's key or value (regex metacharacters are matched verbatim,
never interpreted). Results are shown in the same Offline / Remote split as
\`list\`; an unconfigured remote degrades to a short note, never an error.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --json              Machine-readable output
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --link              Print this view's dashboard deep-link URL instead of running (with --base / --json)

${c.bold('Examples')}
  npx @lorekit/cli search sandbox
  npx @lorekit/cli grep "flaky test" --json
  npx @lorekit/cli search migration --scope global
  npx @lorekit/cli search "flaky test" --scope global --link
`,
  write: `${c.bold('lorekit write')} — create or update a memory from the CLI

${c.bold('Usage')}
  npx @lorekit/cli write <scope::key> <value> [options]
  npx @lorekit/cli write <scope> <key> <value> [options]
  npx @lorekit/cli write --scope <scope> --key <key> <value> [options]
  echo "value" | npx @lorekit/cli write <scope::key> [options]

Creates or updates a memory (upsert — overwrites if the key exists). Value can
be a positional, --value, or piped stdin. Writes to the remote store when
configured, falling back to local.

The single-token <scope::key> form is canonical — it is the format this command
echoes back and the one list/search print, so it round-trips. It is split at the
LAST \`::\`, and only when the left side is itself a complete valid scope, so a
multi-segment scope stays whole: write repo::acme/widget build-flags "..." keeps
repo::acme/widget as the scope. The scope is validated before anything is
written, so a typo is rejected rather than stored. Pass --scope/--key to address
a key that itself contains \`::\`.

${c.bold('Options')}
  -d, --dir <path>         Target project root (default: current directory)
      --scope <scope>      Name the scope explicitly (instead of the positional)
      --key <key>          Name the key explicitly — use for a key containing \`::\`
      --value <text>       Memory value (alternative to positional / stdin)
      --tags <a,b,c>       Comma-separated tags (default: none)
      --source-agent <n>   Source agent name to record (default: none)
      --trigger <slug>     Trigger context slug (default: none)
      --ttl-days <n>       Days until auto-expiry 1–365 (local or remote)
      --clear-ttl          Remove any existing expiry (make it permanent)
      --org <slug>         Write to this org's scope (remote only)
      --origin-repo <o/n>  Override the derived provenance repository
      --origin-branch <b>  Override the derived provenance branch
      --origin-commit <s>  Override the derived provenance commit SHA
      --origin-pr <n>      The pull request this lesson came out of
      --no-origin          Record no provenance at all
      --remote             Force write to the remote store
      --local              Force write to the local offline store
      --json               Machine-readable output
  -e, --endpoint <url>     Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>      Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>       Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli write global::my-key "Always prefer guard clauses"
  npx @lorekit/cli write repo::acme/widget::build-flags "Use --release in CI"
  npx @lorekit/cli write global my-key "Always prefer guard clauses"
  cat notes.md | npx @lorekit/cli write global::my-key --tags "style,aw"
  npx @lorekit/cli write global::my-key "body" --local
  npx @lorekit/cli write global::my-key "body" --ttl-days 30 --remote
  npx @lorekit/cli write --scope global --key "loop::aw-lessons" "body"
`,
  show: `${c.bold('lorekit show')} — inspect one memory in full

${c.bold('Usage')}
  npx @lorekit/cli show <scope::key> [options]
  npx @lorekit/cli show <scope> <key> [options]
  npx @lorekit/cli show --scope <scope> --key <key> [options]

Prints one memory's complete (untruncated) value, scope, key, updated date, tags,
and which store(s) it lives in. If the same scope::key exists in both the offline
and remote stores, both are shown and any divergence in their values is flagged.
Exits non-zero when the key is found in neither readable store.

The single-token <scope::key> form is canonical — it is exactly what list and
search print, so a key can be copy-pasted straight out of their output. It is
split at the LAST \`::\`, and only when the left side is itself a complete valid
scope, so a multi-segment scope stays whole: repo::acme/widget::build-flags is
scope repo::acme/widget, key build-flags. Pass --scope/--key to address a key
that itself contains \`::\`.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --json              Machine-readable output (the full normalized record(s))
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --scope <scope>     Name the scope explicitly (instead of the positional)
      --key <key>         Name the key explicitly — use for a key containing \`::\`
      --link              Print this memory's dashboard deep-link URL instead of reading (with --base / --json)

${c.bold('Examples')}
  npx @lorekit/cli show global::prefer-guard-clauses
  npx @lorekit/cli show repo::acme/widget::build-flags --json
  npx @lorekit/cli show global prefer-guard-clauses
  npx @lorekit/cli show project::widget build-flags --json
  npx @lorekit/cli show --scope global --key "loop::aw-lessons"
  npx @lorekit/cli show global::prefer-guard-clauses --link
`,
  stats: `${c.bold('lorekit stats')} — count the applicable memories per scope and per store

${c.bold('Usage')}
  npx @lorekit/cli stats [options]

Shows how many memories apply to the current directory's scopes (project/branch/
repo/global), broken down per scope and per store (Offline = the local .lorekit/
+ ~/.lorekit/ two-tier store; Remote = the hosted LoreKit API), with per-store and
grand totals. An unconfigured remote degrades to a short note, never an error.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --json              Machine-readable output
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli stats
  npx @lorekit/cli stats --json
  npx @lorekit/cli stats --scope global
`,
  scopes: `${c.bold('lorekit scopes')} — store-wide inventory of every distinct scope

${c.bold('Usage')}
  npx @lorekit/cli scopes [options]

Lists EVERY distinct scope present in the store, with a memory count per scope,
in the same Offline / Remote split as the other read commands. Unlike \`list\` /
\`stats\` (which only see the scopes that resolve for the current directory), this
is a full inventory — it surfaces scopes anywhere in the store, regardless of the
current directory.

Offline counts are exact: each scope is read from the memory files' frontmatter,
not reverse-mapped from the directory layout. Remote counts are exact too — they
come from \`GET /memories/scopes\`, which aggregates one row per scope server-side.
A denied, unconfigured, or unreachable remote degrades to a short, accurate note
rather than an error (exit 0).

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <substr>    Filter the inventory to scopes containing this substring
      --json              Machine-readable output
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli scopes
  npx @lorekit/cli scopes --json
  npx @lorekit/cli scopes --scope repo::
`,
  diff: `${c.bold('lorekit diff')} — compare the offline and remote stores

${c.bold('Usage')}
  npx @lorekit/cli diff [options]

Compares the local (offline) store against the hosted (remote) store for the
current directory's scopes and reports where they diverge, grouped by scope:
local-only keys, remote-only keys, and conflicting keys (same key, different
value or tags). A diff needs BOTH stores readable — if the remote is
unconfigured or a store is denied, \`diff\` prints a clear note and exits 0.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --json              Machine-readable output
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli diff
  npx @lorekit/cli diff --json
  npx @lorekit/cli diff --scope global
`,
  tree: `${c.bold('lorekit tree')} — show the scope precedence hierarchy and which memory wins ${c.dim('(alias: resolve)')}

${c.bold('Usage')}
  npx @lorekit/cli tree [options]

Shows the scopes the hooks actually inject for the current directory — project,
branch, repo, global, in precedence order (most-specific first) — and marks, for any key
present at more than one scope, which scope's memory WINS and which are shadowed.
This mirrors the SessionStart hook's resolution exactly (a more-specific scope
overrides a broader scope's same-key memory). Resolved independently per store,
in the same Offline / Remote split.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: the injected set)
      --json              Machine-readable output (per-entry winning/shadowedBy tags)
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --link              Print the Explorer deep-link for the most-specific scope (or --scope) instead of running (with --base / --json)

${c.bold('Examples')}
  npx @lorekit/cli tree
  npx @lorekit/cli resolve --json
  npx @lorekit/cli tree --scope global --link
`,
  lint: `${c.bold('lorekit lint')} — flag low-quality memories across the applicable scopes

${c.bold('Usage')}
  npx @lorekit/cli lint [options]

Checks every memory for the current directory's scopes (project/branch/repo/
global), across both stores, against a small set of quality rules: empty or
whitespace-only value, suspiciously short value, untrimmed value, empty key, a
volatile per-sighting identifier in the key (a run of 6+ digits, or a \`pr<n>\` /
\`issue<n>\` reference), and malformed scope (e.g. a single \`:\` where \`::\` is
expected). Each finding names the rule it violated. Exits NON-ZERO when any issue
is found, so it works as a CI gate; a clean run — or one where only a store is
unavailable — exits 0.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --json              Machine-readable output (structured findings list)
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli lint
  npx @lorekit/cli lint --json
  npx @lorekit/cli lint --scope global
`,
  dedupe: `${c.bold('lorekit dedupe')} — find likely-duplicate memories (heuristic)

${c.bold('Usage')}
  npx @lorekit/cli dedupe [options]

Groups memories whose values overlap heavily into duplicate clusters, per store,
across the current directory's scopes. The similarity signal is a zero-dependency
HEURISTIC — Jaccard overlap of lowercased word tokens, not a semantic/embedding
measure — so it surfaces candidates for a human to review, and can both miss
paraphrases and group coincidental overlaps. Tune the cutoff with --threshold.

Pass --cluster-by-key <regex> to cluster by KEY shape instead of value overlap:
entries whose keys share the same first capture group (or full match) form one
family. This catches coordinate-key debt — e.g. many pr{N}-{commentId} rows for
one review comment — that the value heuristic misses when the values differ.
Key-shape mode has no similarity cutoff, so --threshold and --cluster-by-key are
mutually exclusive: passing both is a usage error rather than a silent ignore.

${c.bold('Options')}
  -d, --dir <path>          Target project root (default: current directory)
      --scope <scope>       Restrict to a single scope (default: all applicable)
      --threshold <0..1>    Similarity cutoff to cluster a pair (default: 0.8)
      --cluster-by-key <re> Cluster by shared key capture instead of value overlap
      --json                Machine-readable output (clusters + signal)
  -e, --endpoint <url>      Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>       Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>        Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli dedupe
  npx @lorekit/cli dedupe --threshold 0.6 --json
  npx @lorekit/cli dedupe --cluster-by-key "(pr\\d+-\\d+)" --json
`,
  obligations: `${c.bold('lorekit obligations')} — check a changed-file set against the Surface-Partner Map

${c.bold('Usage')}
  npx @lorekit/cli obligations <path>... [options]
  npx @lorekit/cli obligations --files <path>... [options]
  git diff --name-only | npx @lorekit/cli obligations [options]

Checks a changed-file set against a declarative registry of known, path-keyed
file partnerships (a mirrored module, a doc that copies a claim, a generated
artifact) mined from existing CI guards — a machine version of the recurring
review finding "you fixed one surface and left its partner stale." For each
matched partnership it prints the obliged partner files/actions and flags any
partner NOT in the given changed-set, citing the memory lesson the
partnership encodes.

Cwd-INDEPENDENT: it matches the path STRINGS it is given against the map — it
never reads the filesystem or resolves scope from the current directory, so
the changed-set can come from anywhere (a git diff, a PR file list, by hand).

The changed-set is positionals unioned with ${c.cyan('--files')} (its single-value
form — extra paths after it fall through as positionals); when neither is
given, it falls back to stdin lines (newline-separated, trimmed, non-empty),
read only when stdin is piped.

${c.bold('Options')}
      --files <path>...   Changed files to check (also: positionals, stdin)
      --strict            Exit non-zero when any path obligation is unmet
                          (an advisory run: action never gates this)
      --json              Machine-readable output ({ files, matched, unmet, ok })

${c.bold('Examples')}
  npx @lorekit/cli obligations supabase/functions/_shared/audit/audit.ts
  npx @lorekit/cli obligations --files packages/schemas/src/shared/tool-catalog.ts --json
  git diff --name-only origin/main... | npx @lorekit/cli obligations --strict
`,
  link: `${c.bold('lorekit link')} — print a shareable dashboard deep-link URL ${c.dim('(alias: url)')}

${c.bold('Usage')}
  npx @lorekit/cli link [scope] [key] [options]
  npx @lorekit/cli link <scope::key> [options]

Prints a ${c.cyan('lorekit.io/lore')} deep link to stdout — nothing else — so it pipes
cleanly into your clipboard or a message. With no arguments it links to the
current directory's most-specific scope ("share what I'm looking at"). Given a
scope it links to the Explorer filtered to that scope; given a scope AND key (or
the ${c.cyan('scope::key')} shorthand) it links straight to that lesson's detail sheet.

Every param is JSON-encoded exactly as the dashboard reads it, so the link opens
the intended view — a raw ${c.dim('?scope=global')} would silently mean "all scopes".

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Scope to link to (when no positional scope is given)
      --key <key>         Name the key explicitly — the way to link to a key
                          that itself contains \`::\`
      --q <text>          Pre-fill the Explorer search box
      --owner <o>         Ownership filter: all | personal | <org-slug>
      --tags <a,b,c>      Label filter (AND across labels); comma-separated or a JSON array
      --range <json>      Date range as {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}
      --from <date>       Range start (shorthand for --range)
      --to <date>         Range end (shorthand for --range)
      --archived          Include archived memories
      --base <url>        Dashboard base URL (else LOREKIT_APP_URL, default https://lorekit.io)
      --json              Machine-readable { url, surface, base, params }

${c.bold('Examples')}
  npx @lorekit/cli link                              # link to the current repo/branch context
  npx @lorekit/cli link | pbcopy                     # copy it straight to the clipboard
  npx @lorekit/cli link global                       # the Explorer filtered to global scope
  npx @lorekit/cli link repo::owner/repo prefer-guards   # open one lesson's detail sheet
  npx @lorekit/cli link global::prefer-guards --json     # { url, surface, base, params }
  npx @lorekit/cli url --q "flaky test" --owner personal # search + ownership filter
  npx @lorekit/cli link global --tags "perf,ci"          # Explorer filtered to labels
`,
  migrate: `${c.bold('lorekit migrate')} — relocate a LoreKit-format local store, or push it to the hosted store

${c.bold('Usage')}
  npx @lorekit/cli migrate --from <path> [options]

Dry-run by default; pass --yes (or --apply) to write. Idempotent.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --from <path>       Source store to migrate from (required)
      --to <dest>         Destination: home | project | remote (default routes by
                          scope across the local tiers)
      --apply             Apply the migration (alias of --yes)
  -y, --yes               Apply the migration; never prompt

${c.bold('--to remote')}
Pushes every entry in the source store up to the hosted store, over the
connection and token \`lorekit install\` configured (\`--endpoint\` / \`--token\`
override both). A read-only \`lk_ro_*\` token is rejected before anything is
written; an unrecognized prefix only warns and proceeds, so a self-hosted or
custom token still works.

What the hosted store does NOT take verbatim:
  - archived and expired entries are skipped — a write would insert a second,
    live row beside the archived one, and any TTL would re-date an expired one
  - \`tags\` REPLACE the hosted row's labels, so an untagged local entry clears
    them
  - a creation date is honoured only when the lesson is new to the hosted
    store, and an unusable one is dropped for the write instant
  - \`updated\` and the \`seen_count\` tally are re-derived by the server, and a
    TTL beyond 365 days is shortened
Every one of those is reported per entry, in the dry run as well as the apply.

${c.bold('Examples')}
  npx @lorekit/cli migrate --from .lore                 # preview a rename
  npx @lorekit/cli migrate --from .lore --to project --yes
  npx @lorekit/cli migrate --from .lorekit --to remote        # preview the push
  npx @lorekit/cli migrate --from .lorekit --to remote --yes  # push local lore up
`,
  archive: `${c.bold('lorekit archive')} — hide a memory without losing it

${c.bold('Usage')}
  lorekit archive <scope::key>
  lorekit archive <scope> <key>
  lorekit archive --scope <scope> --key <key>

Soft-archives one memory: it stops appearing in reads and in the hooks' injected
context, but it is still there and ${c.cyan('lorekit restore')} brings it back. Reach for
this rather than ${c.cyan('delete')} when a lesson has stopped being true — the record of
having learned it is usually worth keeping.

Addresses a memory the same three ways ${c.cyan('write')} / ${c.cyan('show')} do, and picks a store with
the same precedence (remote when usable, else local; ${c.cyan('--remote')} / ${c.cyan('--local')} force it).

${c.bold('Scoped API tokens')}
Server-side this is scope-authorized: a token restricted to a scope may archive
every writer's row in that scope, while an unscoped token may only archive its
own. A no-match is reported as not-found rather than a silent success.

${c.bold('Options')}
      --scope <scope>     Name the scope explicitly
      --key <key>         Name the key explicitly — for a key containing \`::\`
      --remote / --local  Force a store instead of the usual precedence
      --json              Machine-readable result
`,

  delete: `${c.bold('lorekit delete')} — archive a memory, or destroy it with --force ${c.dim('(alias: rm)')}

${c.bold('Usage')}
  lorekit delete <scope::key>            # soft-archive (reversible)
  lorekit delete <scope::key> --force    # hard-delete (unrecoverable)

Without ${c.cyan('--force')} this is exactly ${c.cyan('lorekit archive')} — the memory is hidden and
restorable. With ${c.cyan('--force')} the row is gone and no restore can bring it back.

${c.bold('Scoped API tokens')}
Same scope authorization as ${c.cyan('archive')}: a scope-restricted token may act on any
writer's row within its scopes, an unscoped one only on its own, and a 0-row
result is reported as not-found rather than as success.

${c.bold('Options')}
      --force             Hard-delete instead of archiving. Unrecoverable
      --scope <scope>     Name the scope explicitly
      --key <key>         Name the key explicitly — for a key containing \`::\`
      --remote / --local  Force a store instead of the usual precedence
      --json              Machine-readable result
`,

  restore: `${c.bold('lorekit restore')} — bring an archived memory back

${c.bold('Usage')}
  lorekit restore <scope::key>
  lorekit restore <scope> <key>

Un-archives a memory so it appears in reads again. The counterpart to
${c.cyan('archive')} (and to ${c.cyan('delete')} without ${c.cyan('--force')}). A memory that was hard-deleted
cannot be restored — there is nothing left to restore.

Restoring something that is already active is not an error; it reports that
nothing changed.

${c.bold('Options')}
      --scope <scope>     Name the scope explicitly
      --key <key>         Name the key explicitly — for a key containing \`::\`
      --remote / --local  Force a store instead of the usual precedence
      --json              Machine-readable result
`,

  bootstrap: `${c.bold('lorekit bootstrap')} — apply the LoreKit schema to your own Supabase database

${c.bold('Usage')}
  lorekit bootstrap [--yes]

For BYOD ("bring your own database") only: creates the tables, functions and
policies LoreKit needs in a Supabase project you control, so lore never leaves
your infrastructure. You only need this if you are pointing the CLI at your own
database via ${c.cyan('LOREKIT_STORAGE_URL')} / ${c.cyan('LOREKIT_STORAGE_ANON_KEY')} — the hosted
service and the offline store both need nothing here.

See ${c.cyan('docs/byod.md')} for the full setup, including which key to use and what the
schema contains.

${c.bold('Options')}
  -y, --yes                Apply without prompting
      --endpoint <url>     Target endpoint
      --token <token>      Token for the target
`,

  purge: `${c.bold('lorekit purge')} — permanently delete archived memories past a retention window

${c.bold('Usage')}
  lorekit purge [--retention-days <1..365>] [--yes] [--json]

Hard-deletes ARCHIVED memories older than the retention window. Archived lore is
hidden from reads but recoverable with ${c.cyan('lorekit restore')} — this is what makes it
unrecoverable, so it is the one step in the lifecycle that cannot be walked back.

${c.bold('Remote only')}
It sweeps server-side state; the offline store has no equivalent, so ${c.cyan('--local')} is
refused rather than quietly doing nothing.

${c.bold('Confirmation')}
There is no dry run: the purge RPC returns its count only AFTER deleting, so
"would purge N" cannot be answered honestly. Instead you are asked to confirm,
and ${c.cyan('--yes')} is REQUIRED when there is no terminal to ask (a pipe, CI, or --json)
— an unattended agent must not be able to purge by omission.

${c.bold('Scoped tokens')}
A token restricted to specific scopes is refused by the server: an account-wide
sweep has no scope to check and no result set to narrow. Use an unscoped token
for maintenance.

${c.bold('Options')}
      --retention-days <n>  Only purge archived memories older than n days
                            (1-365, default ${PURGE_RETENTION_DAYS_DEFAULT})
  -y, --yes                 Confirm; required when non-interactive
      --json                Machine-readable result ({ ok, purged, error })
  -e, --endpoint <url>      LoreKit endpoint (else LOREKIT_MCP_URL)
  -t, --token <token>       LoreKit token (needs write permission, unscoped)
`,

  'purge-expired': `${c.bold('lorekit purge-expired')} — permanently delete every TTL-expired memory

${c.bold('Usage')}
  lorekit purge-expired [--yes] [--json]

Hard-deletes memories whose ${c.cyan('ttl_days')} window has passed. Complementary to
${c.cyan('lorekit purge')}, which removes archived rows: this one removes rows that expired
on their own. Takes no options of its own — the row set is every expired memory
you own.

Same posture as ${c.cyan('purge')}: remote only, account-wide, irreversible, confirmation
required (${c.cyan('--yes')} when non-interactive), and refused for a token restricted to
specific scopes.

${c.bold('Options')}
  -y, --yes               Confirm; required when non-interactive
      --json              Machine-readable result ({ ok, purged, error })
  -e, --endpoint <url>    LoreKit endpoint (else LOREKIT_MCP_URL)
  -t, --token <token>     LoreKit token (needs write permission, unscoped)
`,

  groom: `${c.bold('lorekit groom')} — preview or run a retention sweep

${c.bold('Usage')}
  lorekit groom --policy-id <id> [--run] [--yes] [--json]
  lorekit groom --scope <s> [--min-age-days <n>] [--unseen-days <n>] [--max-seen-count <n>] [--run] [--yes] [--json]

Resolves the SAME candidates a saved policy or an inline condition set would
catch, via the retention-policy candidate query — a previewed count always
equals what --run would archive. Exactly one of --policy-id or --scope is
required.

Default (no --run) PREVIEWS: prints the count and up to 20 matching keys,
changes nothing. --run ARCHIVES them (soft-archive, recoverable via
${c.cyan('lorekit restore')}) — prompts for confirmation first, ${c.cyan('--yes')} to skip
non-interactively.

Remote only — retention policies have no local-store equivalent.

${c.bold('Options')}
      --policy-id <id>       Run/preview a saved policy (mutually exclusive with --scope)
      --scope <s>            Inline scope to match (mutually exclusive with --policy-id)
      --min-age-days <n>     Match only lessons at least n days old
      --unseen-days <n>      Match lessons unseen for at least n days (never-seen always matches)
      --max-seen-count <n>   Match only lessons that recurred at most n times
      --run                  Archive the matches instead of previewing
  -y, --yes                  Confirm --run; required when non-interactive
      --json                 Machine-readable result
  -e, --endpoint <url>       LoreKit endpoint (else LOREKIT_MCP_URL)
  -t, --token <token>        LoreKit token (needs write permission for --run)
`,

  policy: `${c.bold('lorekit policy')} — manage saved retention rules

${c.bold('Usage')}
  lorekit policy list [--json]
  lorekit policy create --scope <s> --name <n> [--mode review|auto] [--enabled]
                         [--min-age-days <n>] [--unseen-days <n>] [--max-seen-count <n>]
  lorekit policy update <id> [--name <n>] [--mode review|auto] [--enabled|--disabled]
                         [--min-age-days <n>|--clear-min-age-days] [...] [--json]
  lorekit policy delete <id> [--yes] [--json]

A policy is a saved retention rule: a scope plus AND-ed conditions
(min-age-days / unseen-days / max-seen-count). \`mode: review\` surfaces it for
you to run by hand with ${c.cyan('lorekit groom --policy-id')}; \`mode: auto\` gets swept
nightly, but ONLY once you also pass --enabled — auto starts disabled on
every new policy so a saved rule never archives anything unattended.

Remote only — retention_policies has no local-store equivalent.

${c.bold('Options')}
      --scope <s>            Scope the policy matches (create)
      --name <n>             Policy name (create) / new name (update)
      --mode <review|auto>   Match mode (create/update)
      --enabled / --disabled Turn auto-mode on/off (create/update)
      --min-age-days <n>, --unseen-days <n>, --max-seen-count <n>
                             Conditions (create/update)
      --clear-min-age-days, --clear-unseen-days, --clear-max-seen-count
                             Remove a condition (update only)
  -y, --yes                  Confirm delete; required when non-interactive
      --json                 Machine-readable result
  -e, --endpoint <url>       LoreKit endpoint (else LOREKIT_MCP_URL)
  -t, --token <token>        LoreKit token (needs write permission for create/update/delete)
`,

  protect: `${c.bold('lorekit protect')} — exclude a memory from every grooming sweep

${c.bold('Usage')}
  lorekit protect <scope::key> [--off] [--json]
  lorekit protect <scope> <key> [--off] [--json]

Marks (or, with --off, unmarks) a lesson as protected: excluded from
${c.cyan('lorekit groom')} and every retention policy's candidate set, regardless of
which policy would otherwise have matched it. See also ${c.cyan('lorekit pin')} /
${c.cyan('lorekit unpin')}, the same operation under shorter names.

Remote only.

${c.bold('Options')}
      --off                  Unprotect instead of protect
      --scope <scope>        Name the scope explicitly, overriding the positional
      --key <key>            Name the key explicitly
      --json                 Machine-readable result
  -e, --endpoint <url>       LoreKit endpoint (else LOREKIT_MCP_URL)
  -t, --token <token>        LoreKit token (needs write permission)
`,

  pin: `${c.bold('lorekit pin')} — shorthand for \`lorekit protect\`

${c.bold('Usage')}
  lorekit pin <scope::key> [--json]

Identical to \`lorekit protect <scope::key>\`. See ${c.cyan('lorekit protect --help')}.
`,

  unpin: `${c.bold('lorekit unpin')} — shorthand for \`lorekit protect --off\`

${c.bold('Usage')}
  lorekit unpin <scope::key> [--json]

Identical to \`lorekit protect <scope::key> --off\`. See ${c.cyan('lorekit protect --help')}.
`,

  hook: `${c.bold('lorekit hook')} — hook engine for Claude Code / Cursor / Codex

${c.bold('Usage')}
  lorekit hook --adapter <claude|cursor|codex> --event <name> [--dir <path>]

Machine-facing: reads the host's JSON on stdin and injects memories or a
retrospective nudge on stdout, always exiting 0. Wired into a plugin's hook
config by \`lorekit install\` — not run by hand.

${c.bold('Options')}
  -d, --dir <path>        Target project root
      --adapter <name>    Host framework: claude | cursor | codex
      --event <name>      Host hook event (else read from the stdin payload)
`,
  mcp: `${c.bold('lorekit mcp')} — local stdio MCP server

${c.bold('Usage')}
  lorekit mcp [--dir <path>]

Machine-facing: exposes the memory.* tools backed by the resolved store (local
.lorekit/ offline, or remote passthrough) over JSON-RPC on stdin/stdout, so
.mcp.json can point at the CLI instead of mcp-remote. Not run by hand.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
`,
  completion: `${c.bold('lorekit completion')} — print a shell completion script

${c.bold('Usage')}
  lorekit completion <zsh|fish>

Prints the completion script for the given shell to stdout. It completes command
names and aliases, each command's own flags, and — read live from the LOCAL
store — scope values (\`--scope\`) and \`scope::key\` addresses (\`show\`, \`write\`,
\`archive\`, \`delete\`, \`restore\`, \`link\`). Dynamic completion is offline: it never
prompts for a token or hits the network, so a remote-only scope will not appear.

The easiest way to install it is ${c.cyan('lorekit install --completions auto')}, which
detects your shell and wires it up. To do it by hand:

${c.bold('zsh')}
  lorekit completion zsh > ~/.zsh/completions/_lorekit
  # ensure that dir is on \$fpath before \`compinit\` in ~/.zshrc

${c.bold('fish')}
  lorekit completion fish > ~/.config/fish/completions/lorekit.fish

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
`,
};

// Every long flag the CLI understands (after alias resolution). Passed to the
// parser so an unrecognized flag is captured rather than silently ignored — a
// typo like `--gloabl` should fail loudly, not quietly fall back to --project.
const KNOWN_FLAGS = [
  'dir', 'project', 'global', 'endpoint', 'token', 'mode', 'store',
  'from', 'to', 'apply', 'yes', 'hooks', 'no-hooks', 'mcp-json', 'completions', 'complete', 'force', 'deep', 'adapter',
  'event', 'json', 'scope', 'key', 'threshold', 'help', 'version', 'telemetry',
  'value', 'tags', 'source-agent', 'trigger', 'kind', 'host', 'ttl-days', 'clear-ttl', 'org', 'remote', 'local',
  // `view` is accepted-and-IGNORED, not documented: the Explorer dropped the
  // scope/time tab so the flag is a no-op, but `link` is a HUMAN_COMMAND that
  // rejects UNKNOWN options — so keeping `view` listed for a release stops an
  // existing `lorekit link --view time` from hard-failing on an unknown-option
  // error. It is parsed and discarded (nothing reads `args.view`). Remove it once
  // 1.x links have aged out.
  'link', 'base', 'q', 'owner', 'range', 'archived', 'view',
  'retention-days',
  'origin-repo', 'origin-branch', 'origin-commit', 'origin-pr', 'no-origin',
  // Scale-aware survey flags
  'all', 'max', 'since', 'until', 'key-prefix', 'cluster-by-key',
  // groom / policy / protect / pin / unpin
  'policy-id', 'min-age-days', 'unseen-days', 'max-seen-count', 'run',
  'name', 'mode', 'enabled', 'disabled',
  'clear-min-age-days', 'clear-unseen-days', 'clear-max-seen-count', 'off',
  // `obligations`
  'files', 'strict',
];

async function main() {
  // Load a `.env` from the current directory (if any) before anything reads the
  // environment — so telemetry config, tokens, and endpoints can come from a
  // file. Best-effort and non-overriding: real env vars still win, a missing
  // file is a silent no-op, and it never prints (safe for hook/mcp stdout).
  loadDotEnv();

  const argv = process.argv.slice(2);
  const args = parseArgs(argv, {
    aliases: { d: 'dir', e: 'endpoint', t: 'token', y: 'yes', h: 'help', v: 'version' },
    booleans: ['yes', 'force', 'deep', 'apply', 'help', 'version', 'global', 'project', 'no-hooks', 'mcp-json', 'no-origin', 'json', 'remote', 'local', 'link', 'archived', 'clear-ttl', 'telemetry', 'all', 'run', 'enabled', 'disabled', 'off', 'clear-min-age-days', 'clear-unseen-days', 'clear-max-seen-count', 'strict'],
    known: KNOWN_FLAGS,
  });

  const command = COMMAND_ALIASES[args._[0]] || args._[0];

  // Help is intercepted first — before the machine-facing hook/mcp dispatch — so
  // `lorekit <command> --help` always documents the command (even hook/mcp)
  // instead of blocking on stdin. Real hook/mcp invocations never pass --help.
  if (args.help) {
    log(command && COMMAND_HELP[command] ? COMMAND_HELP[command] : HELP);
    return 0;
  }

  // Machine-facing commands (`hook`, `mcp`) own their stdout — a host's JSON
  // contract and JSON-RPC frames respectively — so they must bypass the usage
  // and version branches, which print. `machine` in the registry is the single
  // statement of that.
  //
  // They stay UNTRACED — a span per agent event is a firehose of near-identical
  // traces, and these fire several times per turn — but they are no longer
  // SILENT. `meterCommand` emits the invocation COUNTER only, carrying the same
  // identity attributes the traced commands do, on a much tighter export budget
  // (see `METERED_TIMEOUT_MS`). Without it the durable telemetry identity would
  // differentiate users across `list`/`search`/`stats` while the traffic that
  // actually dominates — the hooks on every turn — stayed invisible.
  //
  // The command runs FIRST and its exit code is returned unchanged: the host's
  // stdout contract is written by `run` before any export is attempted, and a
  // telemetry failure can neither alter the exit code nor corrupt the frame.
  const machineEntry = COMMANDS_BY_NAME.get(command);
  if (machineEntry?.machine) {
    return meterCommand(machineEntry.name, VERSION, () => machineEntry.run(args));
  }

  if (args.version) {
    log(VERSION);
    return 0;
  }

  if (!command) {
    log(HELP);
    return 1;
  }

  // Reject unrecognized flags on human-facing commands with an actionable
  // pointer, rather than silently ignoring a typo that would change behavior.
  if (STRICT_FLAG_COMMANDS.has(command) && args._unknown.length > 0) {
    const plural = args._unknown.length > 1 ? 's' : '';
    err(`${c.red(`Unknown option${plural}:`)} ${args._unknown.join(', ')}`);
    err(`Run ${c.cyan(`lorekit ${command} --help`)} to see valid options.`);
    return 1;
  }

  // Every remaining command is dispatched through `traceCommand`, so one OTel
  // span and one counter are emitted per invocation without any command wiring
  // its own — telemetry is INHERITED from this single call site. `hook` and
  // `mcp` returned above and stay uninstrumented by design.
  //
  // This replaced nineteen identical `case` clauses whose only job was to
  // repeat the command name three times. The registry already knows the name
  // and the handler, so adding a command needs no edit here at all — which is
  // what stops the dispatch list and the membership set drifting apart again.
  const entry = COMMANDS_BY_NAME.get(command);
  if (!entry) {
    err(`${c.red('Unknown command:')} ${command}\n`);
    log(HELP);
    return 1;
  }

  return traceCommand(entry.name, args, VERSION, () => entry.run(args));
}

main()
  .then((code) => flushThenExit(code ?? 0))
  .catch((e) => {
    err(`${c.red('Error:')} ${e && e.stack ? e.stack : e}`);
    flushThenExit(1);
  });

// Exit only after stdout/stderr have drained.
//
// `process.exit()` truncates any output still buffered for a PIPE (the shape a
// spawned child's stdout has), because pipe writes are asynchronous. `lorekit
// mcp` streams newline-delimited JSON-RPC frames to stdout, and a large frame —
// e.g. a `memory.list` result for a big scope — overflows the pipe buffer, so
// exiting the instant `main()` resolves drops the tail of that write and the
// client sees a silent "no response" (this reproduced deterministically once a
// scope's payload crossed ~½ MB). Flushing first makes the final frame whole.
// The unref'd safety timer guarantees the process still exits if a stream never
// drains, so this can never turn a finished command into a hang.
function flushThenExit(code) {
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  const safety = setTimeout(() => process.exit(code), 2000);
  safety.unref?.();
  for (const stream of [process.stdout, process.stderr]) {
    try {
      // An empty write's callback fires only after every previously-queued write
      // has flushed to the fd, so it is a reliable drain barrier.
      stream.write('', done);
    } catch {
      done();
    }
  }
}
