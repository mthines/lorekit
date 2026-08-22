// The command registry — the ONE hand-written statement of what commands exist.
//
// Before this file the same list was spelled out four independent times in
// `bin/lorekit.mjs`: a `switch` with one `case` per command, a `HUMAN_COMMANDS`
// set, a `COMMAND_ALIASES` map, and the `COMMAND_HELP` keys. Nothing
// cross-checked them, and they had already disagreed — `bootstrap` was
// dispatched by the `switch` but missing from `HUMAN_COMMANDS`, so it silently
// accepted unknown flags where every sibling rejects them.
//
// What this file does NOT own: the help prose. `HELP` and `COMMAND_HELP` stay in
// `bin/lorekit.mjs`, because they are already in exactly one place — moving ~640
// lines of editorial text here would relocate risk without removing any
// duplication. What was duplicated is MEMBERSHIP, and membership is what lives
// here; a guard asserts every entry below has a help entry there.
//
// Two independent properties, deliberately not one `human` flag:
//
//   traced       — dispatched through `traceCommand`, so one OTel span and one
//                  counter are emitted per invocation. Telemetry is INHERITED
//                  from the dispatcher; a command never wires its own.
//   strictFlags  — rejects unknown options with an actionable pointer instead of
//                  silently ignoring what might be a typo.
//
// `hook` and `mcp` are neither: they are machine-facing, fire on every agent
// event, and own their stdout (a host's JSON contract / JSON-RPC frames), so a
// span's cost and an error message's bytes are both unacceptable there. They are
// marked `machine` and dispatched before the usage branches.
//
// `traced: false` does NOT mean unmeasured. The dispatcher routes `machine`
// commands through `meterCommand`, which emits the invocation COUNTER (with the
// same identity attributes the traced commands carry) and no span, on a tighter
// export budget. These two are the highest-volume entry points in the CLI, so
// leaving them entirely silent meant the usage that dominates was the usage
// nobody could see — a span each is still the wrong trade, a counter is not.

import { install } from './install.mjs';
import { uninstall } from './uninstall.mjs';
import { doctor } from './doctor.mjs';
import { list } from './list.mjs';
import { search } from './search.mjs';
import { show } from './show.mjs';
import { write } from './write.mjs';
import { archive, del, restore } from './remove.mjs';
import { stats } from './stats.mjs';
import { scopes } from './scopes.mjs';
import { diff } from './diff.mjs';
import { tree } from './tree.mjs';
import { lint } from './lint.mjs';
import { dedupe } from './dedupe.mjs';
import { link } from './link.mjs';
import { hook } from './hook.mjs';
import { migrate } from './migrate.mjs';
import { bootstrap } from './bootstrap.mjs';
import { mcpServer } from './mcp-server.mjs';
import { purge, purgeExpired } from './purge.mjs';

/**
 * Every command, in the order the top-level help lists them.
 *
 * `tool` binds a command to a catalog operation (`surfaces.cli` in
 * `packages/schemas/src/tool-catalog.ts`) — the two are cross-checked, so a
 * catalog op claiming a CLI command that does not exist here fails a test.
 * `native` marks a command with no catalog operation and says why, which is
 * most of them: installing, diagnosing and grooming are CLI concerns that no
 * MCP tool corresponds to.
 */
export const COMMANDS = [
  { name: 'install', run: install, traced: true, strictFlags: true, native: 'scaffolds skills, hooks and MCP config on disk' },
  { name: 'uninstall', run: uninstall, traced: true, strictFlags: true, native: 'removes what install wrote' },
  { name: 'doctor', run: doctor, traced: true, strictFlags: true, native: 'connectivity / token / scope health check' },
  { name: 'list', run: list, traced: true, strictFlags: true, tool: 'memory.list', aliases: ['ls'] },
  { name: 'search', run: search, traced: true, strictFlags: true, tool: 'memory.search', aliases: ['grep'] },
  { name: 'show', run: show, traced: true, strictFlags: true, tool: 'memory.read' },
  { name: 'stats', run: stats, traced: true, strictFlags: true, native: 'local rollup over the resolved store' },
  { name: 'scopes', run: scopes, traced: true, strictFlags: true, tool: 'memory.scopes' },
  { name: 'diff', run: diff, traced: true, strictFlags: true, native: 'compares two scopes' },
  { name: 'tree', run: tree, traced: true, strictFlags: true, native: 'resolves the scope hierarchy for a directory', aliases: ['resolve'] },
  { name: 'lint', run: lint, traced: true, strictFlags: true, native: 'quality pass over stored lessons' },
  { name: 'dedupe', run: dedupe, traced: true, strictFlags: true, native: 'near-duplicate detection across a scope' },
  { name: 'link', run: link, traced: true, strictFlags: true, native: 'builds a dashboard deep link', aliases: ['url'] },
  { name: 'migrate', run: migrate, traced: true, strictFlags: true, native: 'moves lore between local and remote stores' },
  { name: 'bootstrap', run: bootstrap, traced: true, strictFlags: true, native: 'seeds a fresh store from a template' },
  { name: 'write', run: write, traced: true, strictFlags: true, tool: 'memory.write' },
  { name: 'archive', run: archive, traced: true, strictFlags: true, tool: 'memory.archive' },
  { name: 'delete', run: del, traced: true, strictFlags: true, tool: 'memory.delete', aliases: ['rm'] },
  { name: 'restore', run: restore, traced: true, strictFlags: true, tool: 'memory.restore' },
  { name: 'purge', run: purge, traced: true, strictFlags: true, tool: 'memory.purge' },
  { name: 'purge-expired', run: purgeExpired, traced: true, strictFlags: true, tool: 'memory.purge_expired' },

  // ── Machine-facing ──────────────────────────────────────────────────────────
  { name: 'hook', run: hook, traced: false, strictFlags: false, machine: true, native: 'host hook engine — stdout is the host\'s JSON contract' },
  { name: 'mcp', run: mcpServer, traced: false, strictFlags: false, machine: true, native: 'local stdio MCP server — stdout is JSON-RPC frames' },
];

/** Command name -> its registry entry. */
export const COMMANDS_BY_NAME = new Map(COMMANDS.map((entry) => [entry.name, entry]));

/**
 * Commands that reject unknown options.
 *
 * They write to disk or talk to the network on a human's behalf, so a typo'd
 * flag must be an error rather than a silently ignored argument that changes
 * what the command does.
 */
export const STRICT_FLAG_COMMANDS = new Set(
  COMMANDS.filter((entry) => entry.strictFlags).map((entry) => entry.name),
);

/** Alias -> canonical command name, resolved before help, dispatch and telemetry. */
export const COMMAND_ALIASES = Object.fromEntries(
  COMMANDS.flatMap((entry) => (entry.aliases ?? []).map((alias) => [alias, entry.name])),
);
