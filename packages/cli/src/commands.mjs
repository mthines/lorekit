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

import { install } from './commands/install.mjs';
import { uninstall } from './commands/uninstall.mjs';
import { doctor } from './commands/doctor.mjs';
import { list } from './commands/list.mjs';
import { search } from './commands/search.mjs';
import { show } from './commands/show.mjs';
import { write } from './commands/write.mjs';
import { archive, del, restore } from './commands/remove.mjs';
import { stats } from './commands/stats.mjs';
import { scopes } from './commands/scopes.mjs';
import { diff } from './commands/diff.mjs';
import { tree } from './commands/tree.mjs';
import { lint } from './commands/lint.mjs';
import { dedupe } from './commands/dedupe.mjs';
import { obligations } from './commands/obligations.mjs';
import { invariants } from './commands/invariants.mjs';
import { link } from './commands/link.mjs';
import { hook } from './commands/hook.mjs';
import { migrate } from './commands/migrate.mjs';
import { bootstrap } from './commands/bootstrap.mjs';
import { mcpServer } from './commands/mcp-server.mjs';
import { purge, purgeExpired } from './commands/purge.mjs';
import { groom } from './commands/groom.mjs';
import { policy } from './commands/policy.mjs';
import { protect, pin, unpin } from './commands/protect.mjs';
import { completion } from './commands/completion.mjs';

/**
 * Every command, in the order the top-level help lists them.
 *
 * `tool` binds a command to a catalog operation (`surfaces.cli` in
 * `packages/schemas/src/shared/tool-catalog.ts`) — the two are cross-checked, so a
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
  { name: 'obligations', run: obligations, traced: true, strictFlags: true, native: 'checks changed files against the surface-partner map' },
  { name: 'invariants', run: invariants, traced: true, strictFlags: true, native: 'compile-pipeline candidate scan over the memory store' },
  { name: 'link', run: link, traced: true, strictFlags: true, native: 'builds a dashboard deep link', aliases: ['url'] },
  { name: 'migrate', run: migrate, traced: true, strictFlags: true, native: 'moves lore between local and remote stores' },
  { name: 'bootstrap', run: bootstrap, traced: true, strictFlags: true, native: 'seeds a fresh store from a template' },
  { name: 'write', run: write, traced: true, strictFlags: true, tool: 'memory.write' },
  { name: 'archive', run: archive, traced: true, strictFlags: true, tool: 'memory.archive' },
  { name: 'delete', run: del, traced: true, strictFlags: true, tool: 'memory.delete', aliases: ['rm'] },
  { name: 'restore', run: restore, traced: true, strictFlags: true, tool: 'memory.restore' },
  { name: 'purge', run: purge, traced: true, strictFlags: true, tool: 'memory.purge' },
  { name: 'purge-expired', run: purgeExpired, traced: true, strictFlags: true, tool: 'memory.purge_expired' },
  { name: 'groom', run: groom, traced: true, strictFlags: true, tool: 'groom.preview' },
  { name: 'policy', run: policy, traced: true, strictFlags: true, tool: 'policy.list' },
  { name: 'protect', run: protect, traced: true, strictFlags: true, tool: 'memory.protect' },
  { name: 'pin', run: pin, traced: true, strictFlags: true, native: 'shorthand for `protect` (protected=true)' },
  { name: 'unpin', run: unpin, traced: true, strictFlags: true, native: 'shorthand for `protect --off` (protected=false)' },

  // ── Machine-facing ──────────────────────────────────────────────────────────
  // `completion` is machine-facing for the same reason hook/mcp are: its stdout
  // is a contract a shell parses — a completion SCRIPT, or (on the `--complete`
  // callback the scripts fire on every TAB) a newline-delimited candidate list.
  // A span per keypress would be a firehose, so it is metered, never traced.
  { name: 'completion', run: completion, traced: false, strictFlags: false, machine: true, native: 'prints shell completion scripts — stdout is a shell contract' },
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
