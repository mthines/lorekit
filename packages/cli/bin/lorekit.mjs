#!/usr/bin/env node
// LoreKit CLI — install the shared-memory skill and run health checks.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { parseArgs, log, err, c } from '../src/util.mjs';
import { install } from '../src/install.mjs';
import { uninstall } from '../src/uninstall.mjs';
import { doctor } from '../src/doctor.mjs';
import { list } from '../src/list.mjs';
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
  install     Scaffold the lorekit-memory skill, wire the LoreKit MCP server,
              and install the deterministic hooks (lessons on SessionStart, a
              nudge on tool failure + at Stop). Prompts to install for this
              project (.claude) or globally for every project (~/.claude);
              --project / --global choose non-interactively, --no-hooks skips
              the hooks (skill stays model-invoked only).
  uninstall   Reverse install: remove the lorekit-memory skill, the MCP server
              entry, and the lifecycle hooks for the chosen scope. Surgical —
              other servers, hooks, and settings are left untouched. Prompts
              project vs global; --project / --global choose non-interactively.
  doctor      Verify the skill install, MCP connectivity, token, and scope.
  list (ls)   List the lessons that apply to the current directory, split into
              an Offline section (local .lorekit/ + ~/.lorekit/) and a Remote
              section (hosted MCP). Groups by scope (project/branch/repo/global).
              --json for scripting, --scope <s> to narrow.
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
      --json              Machine-readable output (list)
      --scope <scope>     Restrict to a single scope (list)
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
  install: `${c.bold('lorekit install')} — scaffold the skill, wire the MCP server, install the hooks

${c.bold('Usage')}
  npx @lorekit/cli install [options]

Scaffolds the lorekit-memory skill, adds the LoreKit MCP server, and wires the
deterministic hooks (lessons on SessionStart, a nudge on tool failure + at Stop).

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

Removes the lorekit-memory skill, the MCP server entry, and the lifecycle hooks.
Surgical — other servers, hooks, and settings are left untouched.

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
  'event', 'json', 'scope', 'help', 'version',
];

// Commands that write to disk / talk to the network on a human's behalf. These
// reject unknown flags; the machine-facing `hook` / `mcp` do not (they must
// never fail on a stray flag, and only ever receive flags we control).
const HUMAN_COMMANDS = new Set(['install', 'uninstall', 'doctor', 'list', 'migrate']);

// Command aliases — canonicalized before help / dispatch so `lorekit ls --help`
// and telemetry both resolve to the real command name.
const COMMAND_ALIASES = { ls: 'list' };

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
