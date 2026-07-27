#!/usr/bin/env node
// LoreKit CLI — install the shared-memory skill and run health checks.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { parseArgs, log, err, c } from '../src/util.mjs';
import { install } from '../src/install.mjs';
import { uninstall } from '../src/uninstall.mjs';
import { doctor } from '../src/doctor.mjs';
import { list } from '../src/list.mjs';
import { search } from '../src/search.mjs';
import { show } from '../src/show.mjs';
import { stats } from '../src/stats.mjs';
import { diff } from '../src/diff.mjs';
import { tree } from '../src/tree.mjs';
import { lint } from '../src/lint.mjs';
import { dedupe } from '../src/dedupe.mjs';
import { hook } from '../src/hook.mjs';
import { migrate } from '../src/migrate.mjs';
import { mcpServer } from '../src/mcp-server.mjs';
import { traceCommand } from '../src/telemetry.mjs';
import { loadDotEnv } from '../src/dotenv.mjs';

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
              LoreKit MCP server, and install the deterministic hooks (lessons
              on SessionStart, a nudge on tool failure + at Stop). Prompts to
              install for this project (.claude) or globally for every project
              (~/.claude); --project / --global choose non-interactively,
              --no-hooks skips the hooks (skills stay model-invoked only).
  uninstall   Reverse install: remove the lorekit-memory + lorekit-setup skills,
              the MCP server entry, and the lifecycle hooks for the chosen scope. Surgical —
              other servers, hooks, and settings are left untouched. Prompts
              project vs global; --project / --global choose non-interactively.
  doctor      Verify the skill install, MCP connectivity, token, and scope.
  list (ls)   List the lessons that apply to the current directory, split into
              an Offline section (local .lorekit/ + ~/.lorekit/) and a Remote
              section (hosted MCP). Groups by scope (project/branch/repo/global).
              --json for scripting, --scope <s> to narrow.
  search      Full-text search the applicable lessons across both stores and all
    (grep)    scopes (case-insensitive, literal substring over key + value),
              rendered in the same Offline/Remote split. --json, --scope <s>.
  show        Inspect one lesson in full: its complete value, scope, key, updated
              date, tags, and which store(s) it lives in (noting any divergence
              when it is in both). --json. Usage: show <scope> <key>.
  stats       Count the applicable lessons per scope and per store (offline vs
              remote), with per-store and grand totals, in the same Offline/
              Remote split. --json, --scope <s>.
  diff        Compare the offline and remote stores for the applicable scopes and
              report divergence: local-only, remote-only, and conflicting keys
              (grouped by scope). Needs both stores readable. --json, --scope <s>.
  tree        Show the injected scopes (branch → repo → global) as a precedence
    (resolve) hierarchy and mark, per key, which scope's lesson WINS and which are
              shadowed — the real hook-resolution order. --json, --scope <s>.
  lint        Flag low-quality lessons (empty/short/untrimmed value, empty key,
              malformed scope) across the applicable scopes and both stores. Exits
              non-zero when issues are found (CI gate). --json, --scope <s>.
  dedupe      Find likely-duplicate lessons via a zero-dep word-overlap HEURISTIC
              (Jaccard >= threshold, not semantic), grouped into clusters per
              store. --json, --scope <s>, --threshold <0..1>.
  migrate     Relocate a LoreKit-format local store into the current layout.
              Dry-run by default; pass --yes to apply. Idempotent.
  hook        Hook engine for Claude Code / Cursor / Codex. Reads the host's
              JSON on stdin and injects lessons or a retrospective nudge.
              Not run by hand — wired into a plugin's hook config.
  mcp         Local stdio MCP server. Exposes the memory.* tools backed by the
              resolved store (local .lorekit/ offline, or remote passthrough) so
              .mcp.json can point at the CLI instead of mcp-remote. Speaks
              JSON-RPC on stdin/stdout — not run by hand.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --project           Install into this project: .claude/skills + .mcp.json (default)
      --global            Install for every project: ~/.claude/skills + ~/.claude.json
  -e, --endpoint <url>    LoreKit MCP endpoint
  -t, --token <token>     LoreKit token (lk_rw_* to allow writes, lk_ro_* read-only)
      --mode <mode>       Memory mode: off | local | remote (doctor override)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --json              Machine-readable output (list / search / show / stats / diff / tree / lint / dedupe)
      --scope <scope>     Restrict to a single scope (list / search / stats / diff / tree / lint / dedupe)
      --threshold <0..1>  Duplicate-similarity cutoff (dedupe; default 0.8)
      --from <path>       Source store to migrate from (migrate)
      --to <tier>         Migration destination tier: home | project (migrate;
                          default routes each entry by scope)
      --apply             Apply the migration (alias of --yes) (migrate)
  -y, --yes               Non-interactive / apply; never prompt
      --no-hooks          Skip wiring the lifecycle hooks (install)
      --force             Overwrite existing skill files (install)
      --deep              Do a write→read→delete round-trip (doctor)
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
authoring) skills, adds the LoreKit MCP server, and wires the deterministic
hooks (lessons on SessionStart, a nudge on tool failure + at Stop).

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --project           Install into this project: .claude/skills + .mcp.json (default)
      --global            Install for every project: ~/.claude/skills + ~/.claude.json
  -e, --endpoint <url>    LoreKit MCP endpoint (else LOREKIT_MCP_URL)
  -t, --token <token>     LoreKit token: lk_rw_* read+write, lk_ro_* read-only, lk_wo_* write-only
      --no-hooks          Skip wiring the lifecycle hooks (skill stays model-invoked only)
      --force             Overwrite existing skill files
  -y, --yes               Non-interactive; never prompt (defaults to --project)

${c.bold('Examples')}
  npx @lorekit/cli install --endpoint https://ref.supabase.co/functions/v1/mcp --token lk_rw_xxx
  npx @lorekit/cli install --global
  npx @lorekit/cli install --no-hooks --yes
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

Checks the node runtime, skill install, resolved memory mode, MCP connectivity,
token, and scope.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --mode <mode>       Override the resolved mode: off | local | remote
  -e, --endpoint <url>    Endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)
      --deep              Do a write→read→delete round-trip

${c.bold('Examples')}
  npx @lorekit/cli doctor
  npx @lorekit/cli doctor --deep
  npx @lorekit/cli doctor --mode local
`,
  list: `${c.bold('lorekit list')} — list the lessons that apply to the current directory ${c.dim('(alias: ls)')}

${c.bold('Usage')}
  npx @lorekit/cli list [options]

Shows the lessons for the scopes that resolve for the current directory
(project/branch/repo/global), split into an Offline section (the local
.lorekit/ + ~/.lorekit/ two-tier store) and a Remote section (the hosted MCP
server). When no remote token/endpoint is configured the Remote section is a
short note on how to set it up — never an error.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --json              Machine-readable output
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli list
  npx @lorekit/cli list --json
  npx @lorekit/cli list --scope global
`,
  search: `${c.bold('lorekit search')} — full-text search the applicable lessons ${c.dim('(alias: grep)')}

${c.bold('Usage')}
  npx @lorekit/cli search <query> [options]

Searches every lesson for the current directory's scopes (project/branch/repo/
global) across both stores, matching the query case-insensitively as a LITERAL
substring of a lesson's key or value (regex metacharacters are matched verbatim,
never interpreted). Results are shown in the same Offline / Remote split as
\`list\`; an unconfigured remote degrades to a short note, never an error.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --json              Machine-readable output
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli search sandbox
  npx @lorekit/cli grep "flaky test" --json
  npx @lorekit/cli search migration --scope global
`,
  show: `${c.bold('lorekit show')} — inspect one lesson in full

${c.bold('Usage')}
  npx @lorekit/cli show <scope> <key> [options]

Prints one lesson's complete (untruncated) value, scope, key, updated date, tags,
and which store(s) it lives in. If the same scope::key exists in both the offline
and remote stores, both are shown and any divergence in their values is flagged.
Exits non-zero when the key is found in neither readable store.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --json              Machine-readable output (the full normalized record(s))
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli show global prefer-guard-clauses
  npx @lorekit/cli show project::widget build-flags --json
`,
  stats: `${c.bold('lorekit stats')} — count the applicable lessons per scope and per store

${c.bold('Usage')}
  npx @lorekit/cli stats [options]

Shows how many lessons apply to the current directory's scopes (project/branch/
repo/global), broken down per scope and per store (Offline = the local .lorekit/
+ ~/.lorekit/ two-tier store; Remote = the hosted MCP server), with per-store and
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
  tree: `${c.bold('lorekit tree')} — show the scope precedence hierarchy and which lesson wins ${c.dim('(alias: resolve)')}

${c.bold('Usage')}
  npx @lorekit/cli tree [options]

Shows the scopes the hooks actually inject for the current directory — branch,
repo, global, in precedence order (most-specific first) — and marks, for any key
present at more than one scope, which scope's lesson WINS and which are shadowed.
This mirrors the SessionStart hook's resolution exactly (a more-specific scope
overrides a broader scope's same-key lesson). Project-scope lessons are NOT
injected by the hooks, so they are not shown here — browse them with \`lorekit list\`.
Resolved independently per store, in the same Offline / Remote split.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: the injected set)
      --json              Machine-readable output (per-entry winning/shadowedBy tags)
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli tree
  npx @lorekit/cli resolve --json
`,
  lint: `${c.bold('lorekit lint')} — flag low-quality lessons across the applicable scopes

${c.bold('Usage')}
  npx @lorekit/cli lint [options]

Checks every lesson for the current directory's scopes (project/branch/repo/
global), across both stores, against a small set of quality rules: empty or
whitespace-only value, suspiciously short value, untrimmed value, empty key, and
malformed scope (e.g. a single \`:\` where \`::\` is expected). Each finding names
the rule it violated. Exits NON-ZERO when any issue is found, so it works as a CI
gate; a clean run — or one where only a store is unavailable — exits 0.

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
  dedupe: `${c.bold('lorekit dedupe')} — find likely-duplicate lessons (heuristic)

${c.bold('Usage')}
  npx @lorekit/cli dedupe [options]

Groups lessons whose values overlap heavily into duplicate clusters, per store,
across the current directory's scopes. The similarity signal is a zero-dependency
HEURISTIC — Jaccard overlap of lowercased word tokens, not a semantic/embedding
measure — so it surfaces candidates for a human to review, and can both miss
paraphrases and group coincidental overlaps. Tune the cutoff with --threshold.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --scope <scope>     Restrict to a single scope (default: all applicable)
      --threshold <0..1>  Similarity cutoff to cluster a pair (default: 0.8)
      --json              Machine-readable output (clusters + similarity signal)
  -e, --endpoint <url>    Remote endpoint override (else .mcp.json / LOREKIT_MCP_URL)
  -t, --token <token>     Remote token override (else .mcp.json / LOREKIT_TOKEN)
      --store <path>      Local project-tier store directory (default: .lorekit)

${c.bold('Examples')}
  npx @lorekit/cli dedupe
  npx @lorekit/cli dedupe --threshold 0.6 --json
`,
  migrate: `${c.bold('lorekit migrate')} — relocate a LoreKit-format local store into the current layout

${c.bold('Usage')}
  npx @lorekit/cli migrate --from <path> [options]

Dry-run by default; pass --yes (or --apply) to write. Idempotent.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
      --from <path>       Source store to migrate from (required)
      --to <tier>         Destination tier: home | project (default routes by scope)
      --apply             Apply the migration (alias of --yes)
  -y, --yes               Apply the migration; never prompt

${c.bold('Examples')}
  npx @lorekit/cli migrate --from .lore                 # preview a rename
  npx @lorekit/cli migrate --from .lore --to project --yes
`,
  hook: `${c.bold('lorekit hook')} — hook engine for Claude Code / Cursor / Codex

${c.bold('Usage')}
  lorekit hook --adapter <claude|cursor|codex> --event <name> [--dir <path>]

Machine-facing: reads the host's JSON on stdin and injects lessons or a
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
};

// Every long flag the CLI understands (after alias resolution). Passed to the
// parser so an unrecognized flag is captured rather than silently ignored — a
// typo like `--gloabl` should fail loudly, not quietly fall back to --project.
const KNOWN_FLAGS = [
  'dir', 'project', 'global', 'endpoint', 'token', 'mode', 'store',
  'from', 'to', 'apply', 'yes', 'no-hooks', 'force', 'deep', 'adapter',
  'event', 'json', 'scope', 'threshold', 'help', 'version',
];

// Commands that write to disk / talk to the network on a human's behalf. These
// reject unknown flags; the machine-facing `hook` / `mcp` do not (they must
// never fail on a stray flag, and only ever receive flags we control).
const HUMAN_COMMANDS = new Set([
  'install', 'uninstall', 'doctor', 'list', 'search', 'show', 'stats', 'diff',
  'tree', 'lint', 'dedupe', 'migrate',
]);

// Command aliases — canonicalized before help / dispatch so `lorekit ls --help`
// and telemetry both resolve to the real command name.
const COMMAND_ALIASES = { ls: 'list', grep: 'search', resolve: 'tree' };

async function main() {
  // Load a `.env` from the current directory (if any) before anything reads the
  // environment — so telemetry config, tokens, and endpoints can come from a
  // file. Best-effort and non-overriding: real env vars still win, a missing
  // file is a silent no-op, and it never prints (safe for hook/mcp stdout).
  loadDotEnv();

  const argv = process.argv.slice(2);
  const args = parseArgs(argv, {
    aliases: { d: 'dir', e: 'endpoint', t: 'token', y: 'yes', h: 'help', v: 'version' },
    booleans: ['yes', 'force', 'deep', 'apply', 'help', 'version', 'global', 'project', 'no-hooks', 'json'],
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

  // `hook` is machine-facing: it must never print help/errors to stdout
  // (that would corrupt the JSON the host parses). Handle it before the
  // usage branch and always resolve to exit 0.
  if (command === 'hook') {
    return hook(args);
  }

  // `mcp` is machine-facing too: only JSON-RPC frames may reach stdout, so it
  // must bypass the usage branch. It serves stdio until the client closes.
  if (command === 'mcp') {
    return mcpServer(args);
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
  if (HUMAN_COMMANDS.has(command) && args._unknown.length > 0) {
    const plural = args._unknown.length > 1 ? 's' : '';
    err(`${c.red(`Unknown option${plural}:`)} ${args._unknown.join(', ')}`);
    err(`Run ${c.cyan(`lorekit ${command} --help`)} to see valid options.`);
    return 1;
  }

  // Human-facing commands are wrapped so we can see which commands people run
  // (one OTel span + counter per invocation). `hook` and `mcp` are handled
  // above and stay uninstrumented — they are machine-facing, fire on every
  // agent event, and must keep stdout to their host protocol.
  switch (command) {
    case 'install':
      return traceCommand('install', args, VERSION, () => install(args));
    case 'uninstall':
      return traceCommand('uninstall', args, VERSION, () => uninstall(args));
    case 'doctor':
      return traceCommand('doctor', args, VERSION, () => doctor(args));
    case 'list':
      return traceCommand('list', args, VERSION, () => list(args));
    case 'search':
      return traceCommand('search', args, VERSION, () => search(args));
    case 'show':
      return traceCommand('show', args, VERSION, () => show(args));
    case 'stats':
      return traceCommand('stats', args, VERSION, () => stats(args));
    case 'diff':
      return traceCommand('diff', args, VERSION, () => diff(args));
    case 'tree':
      return traceCommand('tree', args, VERSION, () => tree(args));
    case 'lint':
      return traceCommand('lint', args, VERSION, () => lint(args));
    case 'dedupe':
      return traceCommand('dedupe', args, VERSION, () => dedupe(args));
    case 'migrate':
      return traceCommand('migrate', args, VERSION, () => migrate(args));
    default:
      err(`${c.red('Unknown command:')} ${command}\n`);
      log(HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    err(`${c.red('Error:')} ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
