#!/usr/bin/env node
// LoreKit CLI — install the shared-memory skill and run health checks.
import process from 'node:process';
import { parseArgs, log, err, c } from '../src/util.mjs';
import { install } from '../src/install.mjs';
import { doctor } from '../src/doctor.mjs';
import { hook } from '../src/hook.mjs';
import { mcpServer } from '../src/mcp-server.mjs';

const VERSION = '1.0.0';

const HELP = `${c.bold('lorekit')} — shared persistent memory for coding agents

${c.bold('Usage')}
  npx @lorekit/cli <command> [options]

${c.bold('Commands')}
  install     Scaffold the lorekit-memory skill into .claude/skills and
              add the LoreKit server to .mcp.json.
  doctor      Verify the skill install, MCP connectivity, token, and scope.
  hook        Hook engine for Claude Code / Cursor / Codex. Reads the host's
              JSON on stdin and injects lessons or a retrospective nudge.
              Not run by hand — wired into a plugin's hook config.
  mcp         Local stdio MCP server. Exposes the memory.* tools backed by the
              resolved store (local .lore/ offline, or remote passthrough) so
              .mcp.json can point at the CLI instead of mcp-remote. Speaks
              JSON-RPC on stdin/stdout — not run by hand.

${c.bold('Options')}
  -d, --dir <path>        Target project root (default: current directory)
  -e, --endpoint <url>    LoreKit MCP endpoint
  -t, --token <token>     LoreKit token (lk_rw_* to allow writes, lk_ro_* read-only)
      --mode <mode>       Memory mode: off | local | remote (doctor override)
      --store <path>      Local store directory (default: .lore)
  -y, --yes               Non-interactive; never prompt
      --force             Overwrite existing skill files (install)
      --deep              Do a write→read→delete round-trip (doctor)
      --adapter <name>    Host framework for hook: claude | cursor | codex
      --event <name>      Host hook event (else read from stdin payload)
  -h, --help              Show this help
  -v, --version           Print the version

${c.bold('Environment')}
  LOREKIT_MODE                         off | local | remote (select a mode)
  LOREKIT_DENY                         comma list of forbidden modes (deny-wins)
  LOREKIT_STORE                        local store directory
  LOREKIT_MCP_URL / LOREKIT_ENDPOINT   endpoint fallback
  LOREKIT_TOKEN                        token fallback
  NO_COLOR                             disable colored output

${c.bold('Examples')}
  npx @lorekit/cli install --endpoint https://ref.supabase.co/functions/v1/mcp --token lk_rw_xxx
  npx @lorekit/cli doctor --deep
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv, {
    aliases: { d: 'dir', e: 'endpoint', t: 'token', y: 'yes', h: 'help', v: 'version' },
    booleans: ['yes', 'force', 'deep', 'help', 'version'],
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
    case 'doctor':
      return doctor(args);
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
