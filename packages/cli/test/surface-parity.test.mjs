// Completeness gate for the CLI's half of the operation surface.
//
// The catalog is the single origin of which operations exist. This asserts the
// CLI agrees with it: every op that claims a command has one, every command
// that claims an op binds back to it, every command is documented, the local
// stdio server dispatches what it says it does, and telemetry is inherited from
// one dispatch site rather than wired per command.
//
// WHY THIS LIVES IN THE CLI PACKAGE. It was first written as a vitest spec in
// `mcp-core`, next to the other cross-tree guards. That looked consistent and
// was quietly broken: `mcp-core` has no dependency on `packages/cli`, so Nx
// neither invalidated its cache nor marked it affected when a CLI file changed.
// Three of five guard-bites came back GREEN purely on a cache hit, and
// `--skip-nx-cache` showed the assertions had been right all along. A gate that
// does not run on the changes it polices is worse than no gate, because it
// reports safety it is not providing. So it lives with its inputs.
//
// It reads `src/surfaces.generated.mjs` rather than the catalog itself: that is
// the CLI's only legitimate view of the catalog (the package is published with
// zero dependencies and cannot import the workspace schemas), and its freshness
// against the real catalog is gated separately by `gen-surfaces.mjs --check` in
// mcp-core. So this checks the CLI against the catalog transitively, without
// pretending the CLI can reach it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MCP_TOOL_NAMES,
  CLI_BINDINGS,
  CLI_ALIASES,
  CLI_EXEMPT,
  LOCAL_MCP_EXEMPT,
} from '../src/surfaces.generated.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const registrySource = read('../src/commands.mjs');
const binSource = read('../bin/lorekit.mjs');
const stdioSource = read('../src/commands/mcp-server.mjs');

// ── parsers ──────────────────────────────────────────────────────────────────
// Source scans, not imports: importing the registry would execute the whole CLI
// module graph (stores, config, telemetry) inside a unit test, and the point is
// to assert against the code that ships rather than a model of it.

/** Parse `COMMANDS` entries out of `commands.mjs`. */
function parseRegistry(source) {
  const block = /export const COMMANDS = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, 'COMMANDS array not found — has commands.mjs been restructured?');
  return [...block[1].matchAll(/\{\s*name:\s*'([^']+)'[^}]*\}/g)].map((match) => {
    const entry = match[0];
    const field = (key) => new RegExp(`${key}:\\s*'([^']*)'`).exec(entry)?.[1] ?? null;
    const flag = (key) => new RegExp(`${key}:\\s*true`).test(entry);
    const aliases = /aliases:\s*\[([^\]]*)\]/.exec(entry)?.[1] ?? '';
    return {
      name: match[1],
      traced: flag('traced'),
      machine: flag('machine'),
      tool: field('tool'),
      native: field('native'),
      aliases: [...aliases.matchAll(/'([^']+)'/g)].map((a) => a[1]),
    };
  });
}

/** Keys of the `COMMAND_HELP` object in `bin/lorekit.mjs`. */
function parseHelpKeys(source) {
  const block = /const COMMAND_HELP = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, 'COMMAND_HELP not found — has bin/lorekit.mjs been restructured?');
  return [...block[1].matchAll(/^ {2}'?([a-z][a-z-]*)'?:\s*`/gm)].map((m) => m[1]);
}

/** Keys of a dispatch map in `mcp-server.mjs`. */
function parseDispatchKeys(source, mapName) {
  const block = new RegExp(`const ${mapName} = \\{([\\s\\S]*?)\\n\\};`).exec(source);
  assert.ok(block, `${mapName} not found — has mcp-server.mjs been restructured?`);
  return [...block[1].matchAll(/^\s*'([a-z_]+(?:\.[a-z_]+)+)':/gm)].map((m) => m[1]);
}

const registry = parseRegistry(registrySource);
const helpKeys = parseHelpKeys(binSource);
const dispatched = [
  ...parseDispatchKeys(stdioSource, 'MEMORY_DISPATCH'),
  ...parseDispatchKeys(stdioSource, 'ORG_DISPATCH'),
];
const byName = new Map(registry.map((e) => [e.name, e]));

describe('the scans found something (anti-vacuity)', () => {
  // Every assertion below iterates one of these lists. A regex that stops
  // matching — after a reformat, say — would make this whole file pass by
  // checking nothing. Floors sit below the real counts so routine additions
  // need no edit here, and far enough above zero to catch a dead parser.
  test('parses the command registry', () => {
    assert.ok(registry.length >= 20, `registry entries: ${registry.length}`);
    assert.ok(registry.filter((e) => e.tool).length >= 8, 'catalog-bound commands');
  });

  test('parses the help keys and dispatch maps', () => {
    assert.ok(helpKeys.length >= 19, `help keys: ${helpKeys.length}`);
    assert.ok(dispatched.length >= 11, `dispatch keys: ${dispatched.length}`);
  });

  test('reads a non-trivial catalog view', () => {
    assert.ok(MCP_TOOL_NAMES.length >= 15, `catalog ops: ${MCP_TOOL_NAMES.length}`);
    assert.ok(Object.keys(CLI_BINDINGS).length >= 8, 'CLI bindings');
  });
});

describe('catalog ↔ CLI commands', () => {
  test('every op that claims a CLI command has one, bound back to it', () => {
    for (const [command, op] of Object.entries(CLI_BINDINGS)) {
      const entry = byName.get(command);
      assert.ok(entry, `${op} binds command "${command}", which the registry does not define`);
      assert.equal(entry.tool, op, `command "${command}" does not bind back to ${op}`);
    }
  });

  test('every registry `tool:` names an op the catalog declares', () => {
    // The other direction, so the binding is a bijection and neither side can
    // name something the other lacks.
    for (const entry of registry) {
      if (!entry.tool) continue;
      assert.ok(MCP_TOOL_NAMES.includes(entry.tool), `"${entry.name}" binds unknown op ${entry.tool}`);
      assert.equal(CLI_BINDINGS[entry.name], entry.tool, `${entry.tool} does not bind back to "${entry.name}"`);
    }
  });

  test('every command declares either a catalog op or a native reason', () => {
    // Neither one makes a command unclassified, which is how one becomes
    // "probably fine" instead of a decision someone made.
    for (const entry of registry) {
      assert.ok(
        entry.tool || entry.native,
        `command "${entry.name}" declares neither a catalog tool nor a native reason`,
      );
    }
  });

  test('aliases agree with the catalog', () => {
    for (const [command, op] of Object.entries(CLI_BINDINGS)) {
      const expected = Object.entries(CLI_ALIASES).filter(([, target]) => target === command).map(([a]) => a).sort();
      assert.deepEqual([...byName.get(command).aliases].sort(), expected, `aliases for ${op}`);
    }
  });

  test('no op is both exempt from the CLI and bound to a command', () => {
    for (const op of Object.keys(CLI_EXEMPT)) {
      assert.ok(
        !Object.values(CLI_BINDINGS).includes(op),
        `${op} is marked cliExempt but IS bound to a command — drop the exemption`,
      );
    }
  });

  test('every memory op is either bound or exempt, never neither', () => {
    for (const op of MCP_TOOL_NAMES.filter((n) => n.startsWith('memory.'))) {
      const bound = Object.values(CLI_BINDINGS).includes(op);
      assert.ok(bound || CLI_EXEMPT[op], `${op} has no CLI command and no declared reason`);
    }
  });
});

describe('every command is documented', () => {
  test('each registry entry has a per-command help entry', () => {
    const missing = registry.map((e) => e.name).filter((n) => !helpKeys.includes(n));
    assert.deepEqual(missing, [], `commands with no COMMAND_HELP entry: ${missing.join(', ')}`);
  });

  test('no help entry describes a command that does not exist', () => {
    const orphans = helpKeys.filter((k) => !byName.has(k));
    assert.deepEqual(orphans, [], `COMMAND_HELP entries with no command: ${orphans.join(', ')}`);
  });
});

describe('catalog ↔ the local stdio MCP server', () => {
  test('dispatches every op that claims no exemption', () => {
    for (const op of MCP_TOOL_NAMES) {
      if (LOCAL_MCP_EXEMPT[op]) continue;
      assert.ok(dispatched.includes(op), `${op} is neither dispatched nor marked localMcpExempt`);
    }
  });

  test('does not dispatch an op it declares exempt', () => {
    // The negative half. Without it an exemption can sit there being false —
    // which is exactly how `memory.restore` was recorded as unbacked while both
    // stores implemented it.
    for (const op of Object.keys(LOCAL_MCP_EXEMPT)) {
      assert.ok(!dispatched.includes(op), `${op} is marked localMcpExempt but IS dispatched`);
    }
  });

  test('dispatches nothing the catalog does not declare', () => {
    for (const op of dispatched) {
      assert.ok(MCP_TOOL_NAMES.includes(op), `stdio dispatches "${op}", undeclared in the catalog`);
    }
  });
});

describe('telemetry is inherited, not per-command', () => {
  test('there is exactly ONE traceCommand call site', () => {
    // The whole point: a command gets its span by being dispatched, not by
    // remembering to ask. A second, hand-rolled wrapper fails here.
    const sites = binSource.match(/traceCommand\(/g) ?? [];
    assert.equal(sites.length, 1, `expected 1 traceCommand call site, found ${sites.length}`);
    assert.match(binSource, /return traceCommand\(entry\.name, args, VERSION, \(\) => entry\.run\(args\)\)/);
  });

  test('the machine-facing commands stay untraced, but are metered', () => {
    // The negative assertion is the half that discriminates: `hook` and `mcp`
    // fire on every agent event and own their stdout, so a SPAN per event is a
    // cost their caller never asked for. If a table ever swept them into the
    // traced set, only this notices.
    //
    // Untraced is not unmeasured, though: they go through `meterCommand`, which
    // emits the invocation counter alone. Both halves are asserted, because
    // either one alone permits the mistake the other catches — dropping the
    // meter makes the CLI's highest-volume traffic invisible again, and reaching
    // for `traceCommand` here puts an awaited 1500 ms export on every agent turn.
    const machine = registry.filter((e) => e.machine);
    assert.deepEqual(machine.map((e) => e.name).sort(), ['hook', 'mcp']);
    for (const entry of machine) assert.equal(entry.traced, false, `${entry.name} must stay untraced`);
    assert.match(
      binSource,
      /if \(machineEntry\?\.machine\) \{\s*\n\s*return meterCommand\(machineEntry\.name, VERSION, \(\) => machineEntry\.run\(args\)\);/,
    );
    // Exactly one metered call site, for the same reason there is exactly one
    // traced one: a second wrapper is a second place for the budget to drift.
    const metered = binSource.match(/meterCommand\(/g) ?? [];
    assert.equal(metered.length, 1, `expected 1 meterCommand call site, found ${metered.length}`);
  });

  test('every other command is traced', () => {
    for (const entry of registry.filter((e) => !e.machine)) {
      assert.equal(entry.traced, true, `command "${entry.name}" is neither machine-facing nor traced`);
    }
  });
});

describe('the derived tables are derived, not restated', () => {
  test('bin/lorekit.mjs derives its tables from the registry', () => {
    assert.match(binSource, /from '\.\.\/src\/commands\.mjs'/);
    // The literals these replaced must not come back — a re-declared table is
    // how the four copies drifted in the first place.
    assert.doesNotMatch(binSource, /const HUMAN_COMMANDS = new Set\(\[/);
    assert.doesNotMatch(binSource, /const COMMAND_ALIASES = \{\s*ls:/);
    assert.doesNotMatch(binSource, /switch \(command\) \{/);
  });

  test('mcp-server.mjs projects its tool defs from the generated artifact', () => {
    assert.match(stdioSource, /from '\.\.\/surfaces\.generated\.mjs'/);
    assert.doesNotMatch(stdioSource, /export const MEMORY_TOOL_DEFS = \[\s*\n\s*\{\s*\n\s*name:/);
  });
});
