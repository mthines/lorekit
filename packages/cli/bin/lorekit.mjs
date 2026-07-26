#!/usr/bin/env node
// LoreKit CLI — install the shared-memory skill and run health checks.
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { parseArgs, log, err, c } from '../src/util.mjs';
import { install } from '../src/install.mjs';
import { uninstall } from '../src/uninstall.mjs';
import { doctor } from '../src/doctor.mjs';
import { hook } from '../src/hook.mjs';
import { migrate } from '../src/migrate.mjs';
import { mcpServer } from '../src/mcp-server.mjs';

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

${c.bold('Examples')}
  npx @lorekit/cli install --endpoint https://ref.supabase.co/functions/v1/mcp --token lk_rw_xxx
  npx @lorekit/cli install --global    # set up memory for every project (~/.claude)
  npx @lorekit/cli uninstall --global  # tear that global setup back down
  npx @lorekit/cli doctor --deep
  npx @lorekit/cli migrate --from .lore                 # preview a rename
  npx @lorekit/cli migrate --from .lore --to project --yes
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv, {
    aliases: { d: 'dir', e: 'endpoint', t: 'token', y: 'yes', h: 'help', v: 'version' },
    booleans: ['yes', 'force', 'deep', 'apply', 'help', 'version', 'global', 'project', 'no-hooks'],
  });

  // `hook` is machine-facing: it must never print help/errors to stdout
  // (that would corrupt the JSON the host parses). Handle it before the
  // help/usage branch and always resolve to exit 0.
  if (args._[0] === 'hook') {
    return hook(args);
  }

  // `mcp` is machine-facing too: only JSON-RPC frames may reach stdout, so it
  // must bypass the help/usage branch. It serves stdio until the client closes.
  if (args._[0] === 'mcp') {
    return mcpServer(args);
  }

  if (args.version) {
    log(VERSION);
    return 0;
  }

  const command = args._[0];

  if (args.help || !command) {
    log(HELP);
    return command ? 0 : args.help ? 0 : 1;
  }

  switch (command) {
    case 'install':
      return install(args);
    case 'uninstall':
      return uninstall(args);
    case 'doctor':
      return doctor(args);
    case 'migrate':
      return migrate(args);
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
