// The CLI + MCP smoke gate, run on every PR as part of `cli:test`.
//
// Two jobs:
//
//   1. COVERAGE. Every command in src/commands.mjs, every alias, every tool the
//      local stdio server dispatches, and every tool the hosted server serves
//      must be exercised by a smoke check — or carry a written exemption. A new
//      command or catalog tool with no smoke fails here, on the PR that adds it.
//   2. THE OFFLINE LANE. Runs test/smoke/cases.mjs against the real binary in a
//      throwaway HOME and project (no network), one subtest per case.
//
// The remote lane (the same cases against a live endpoint) runs at deploy time:
// `node packages/cli/test/smoke/run.mjs --remote <endpoint> <token>`.
//
// WHY HERE. Adding a command touches src/commands.mjs and adding a catalog tool
// regenerates src/surfaces.generated.mjs — both in this package — so this guard
// is always affected by the change it polices (see surface-parity.test.mjs for
// what goes wrong when a guard lives elsewhere).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MCP_TOOL_NAMES } from '../src/surfaces.generated.mjs';
import { CASES, LOCAL_MCP_CALLED, LOCAL_MCP_TOOLS, NOT_SMOKED } from './smoke/cases.mjs';
import { runSmoke } from './smoke/run.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * `{ name, aliases }` for every entry of `COMMANDS` in src/commands.mjs. A
 * source scan, like surface-parity.test.mjs: importing the registry would pull
 * the whole CLI module graph into this process.
 */
function parseCommands(source) {
  const block = /export const COMMANDS = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, 'could not find `export const COMMANDS = [` in src/commands.mjs');
  return [...block[1].matchAll(/\{\s*name:\s*'([^']+)'([^\n]*)\}/g)].map(([, name, rest]) => ({
    name,
    aliases: [...(/aliases:\s*\[([^\]]*)\]/.exec(rest)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
  }));
}

const commands = parseCommands(read('../src/commands.mjs'));
const casesSource = read('./smoke/cases.mjs');
const smoked = new Set(CASES.map((c) => c.command));

describe('CLI smoke coverage', () => {
  test('finds the command registry', () => {
    assert.ok(commands.length >= 20, `parsed only ${commands.length} commands from src/commands.mjs`);
  });

  test('every command has a smoke case or a written exemption', () => {
    const missing = commands.map((c) => c.name).filter((n) => !smoked.has(n) && !NOT_SMOKED[n]);
    assert.deepEqual(
      missing,
      [],
      `No smoke case for: ${missing.join(', ')}. Add one to packages/cli/test/smoke/cases.mjs ` +
        '(or, if it genuinely cannot be smoked, an entry with the reason in NOT_SMOKED).',
    );
  });

  test('every case and exemption names a real command', () => {
    const names = new Set(commands.map((c) => c.name));
    const unknown = [...smoked, ...Object.keys(NOT_SMOKED)].filter((n) => !names.has(n));
    assert.deepEqual(unknown, [], `cases.mjs names commands that do not exist: ${unknown.join(', ')}`);
    for (const [name, reason] of Object.entries(NOT_SMOKED)) {
      assert.ok(String(reason).trim().length > 0, `NOT_SMOKED.${name} needs a reason`);
      assert.ok(!smoked.has(name), `${name} is both smoked and exempt — drop the exemption`);
    }
  });

  test('every alias is invoked by a case', () => {
    const aliases = commands.flatMap((c) => c.aliases);
    const missing = aliases.filter((a) => !casesSource.includes(`'${a}'`));
    assert.deepEqual(missing, [], `aliases no case invokes: ${missing.join(', ')}`);
  });

  test('every case runs in at least one lane', () => {
    const laneless = CASES.filter((c) => c.lanes.length === 0).map((c) => `${c.command} — ${c.name}`);
    assert.deepEqual(laneless, []);
  });
});

describe('MCP smoke coverage', () => {
  test('the offline `mcp` case calls every tool the local stdio server dispatches', () => {
    assert.deepEqual(
      [...LOCAL_MCP_CALLED].sort(),
      [...LOCAL_MCP_TOOLS].sort(),
      'LOCAL_MCP_CALLED in smoke/cases.mjs drifted from the catalog (MCP_TOOL_NAMES minus LOCAL_MCP_EXEMPT)',
    );
    const notInSession = LOCAL_MCP_CALLED.filter((t) => !casesSource.includes(`name: '${t}'`));
    assert.deepEqual(notInSession, [], `listed in LOCAL_MCP_CALLED but never called: ${notInSession.join(', ')}`);
  });

  test('scripts/smoke/smoke-mcp-tools.mjs calls every tool the hosted server serves', () => {
    // The hosted smoke runs at deploy time (deploy.yml smoke-preview, preview.yml)
    // against a real project. This makes its coverage a PR-time guarantee.
    const hosted = read('../../../scripts/smoke/smoke-mcp-tools.mjs');
    const missing = MCP_TOOL_NAMES.filter(
      (t) => !new RegExp(`(call\\(|name: )'${t.replace('.', '\\.')}'`).test(hosted),
    );
    assert.deepEqual(
      missing,
      [],
      `No hosted smoke check calls: ${missing.join(', ')}. Add a check() to scripts/smoke/smoke-mcp-tools.mjs.`,
    );
  });
});

test('CLI smoke — offline lane against the real binary', async (t) => {
  const { results } = await runSmoke({ lane: 'offline' });
  assert.ok(results.length > 0, 'no offline cases ran');
  for (const r of results) {
    await t.test(r.label, () => {
      if (r.outcome === 'fail') assert.fail(r.detail);
    });
  }
});
