import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MCP_TOOLS } from '@lorekit/schemas/tool-catalog';
import { REST_TOOL_NAMES, restToolName } from '../rest/rest-tool-name.js';
import {
  NON_CATALOG_OPS,
  REST_ONLY_OP_NAMES,
  TELEMETRY_OP_NAMES,
  isDeclaredOpName,
} from './telemetry-vocabulary.js';

/**
 * Two things, and they are different jobs.
 *
 * FIRST, vocabulary closure. `restToolName` is total by design: an unrecognised
 * route yields `"<fn>.<method>.unmapped"` rather than throwing, so analytics
 * gets a visible bucket instead of a corrupted neighbouring series. Good
 * runtime behaviour, silent development behaviour — nothing fails, so the gap
 * surfaces only when somebody reads a query. `rest-tool-name.spec.ts` already
 * closes half of that (no registered route resolves to `.unmapped`); the other
 * half is here: no route resolves to a name nobody DECLARED, and no
 * declaration sits there naming a route that no longer exists.
 *
 * SECOND, the REST-only decision (D17). The five analytics reads are absent
 * from the agent surface on purpose. A decision recorded only in prose is what
 * a future surface audit re-litigates — it reads as a gap, somebody "fixes" it,
 * and `tools/list` grows five entries every session pays for. Recorded as a
 * guarded field it reads as a decision. So the five are pinned by name, the
 * near-miss (`memory.relevant`, which looks like a sixth and is already covered
 * agent-side) is pinned as explicitly NOT one of them, and the prose record is
 * checked to still exist.
 *
 * Note what is NOT asserted: "every catalog tool is in the vocabulary".
 * `TELEMETRY_OP_NAMES` is BUILT from `MCP_TOOLS`, so that would only confirm
 * `Set` works.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

/** Every name `restToolName` can actually return, table plus the `?force` branch. */
const RESOLVABLE_NAMES: readonly string[] = [
  ...new Set([
    ...Object.values(REST_TOOL_NAMES),
    restToolName({ fn: 'memories', method: 'DELETE', path: '/:id', force: true }),
    restToolName({ fn: 'memories', method: 'DELETE', path: '/:id', force: false }),
  ]),
];

describe('telemetry vocabulary closure', () => {
  it('declares every name a REST route can report', () => {
    // Anti-vacuity: an empty (or collapsed) table would make the loop below
    // assert nothing at all.
    expect(RESOLVABLE_NAMES.length).toBeGreaterThanOrEqual(20);

    const undeclared = RESOLVABLE_NAMES.filter((name) => !isDeclaredOpName(name));
    expect(
      undeclared,
      'these names reach usage_events but are declared nowhere — add an MCP tool to the '
      + 'catalog, or a NON_CATALOG_OPS entry with the reason it has none:\n  '
      + undeclared.join('\n  '),
    ).toEqual([]);
  });

  it('leaves no dead declaration — every declared non-catalog op is still reachable', () => {
    // The other direction. A route renamed or removed without touching this
    // module leaves an entry whose reason describes something that no longer
    // exists, which is worse than no entry: it reads as current.
    const reachable = new Set(RESOLVABLE_NAMES);
    const orphaned = Object.keys(NON_CATALOG_OPS).filter((name) => !reachable.has(name));
    expect(orphaned, `no REST route reports these any more:\n  ${orphaned.join('\n  ')}`).toEqual([]);
  });

  it('does not declare a non-catalog op that is actually a catalog tool', () => {
    // Both halves feed one Set, so a name in both would be invisible there
    // while its `reason` claimed it has no MCP tool.
    const catalogued = new Set(MCP_TOOLS.map((t) => t.name));
    const doubled = Object.keys(NON_CATALOG_OPS).filter((name) => catalogued.has(name));
    expect(doubled, `these have an MCP tool, so drop their NON_CATALOG_OPS entry: ${doubled}`).toEqual([]);
  });

  it('gives every declaration a real reason', () => {
    for (const [name, op] of Object.entries(NON_CATALOG_OPS)) {
      expect(op.reason.length, `${name} needs a reason, not a placeholder`).toBeGreaterThan(20);
      if (op.restOnly !== undefined) {
        expect(op.restOnly.length, `${name}.restOnly needs a reason`).toBeGreaterThan(20);
      }
    }
  });

  it('is total — an unlisted name is not declared', () => {
    expect(isDeclaredOpName('memory.write')).toBe(true);
    expect(isDeclaredOpName('memories.put.unmapped')).toBe(false);
    expect(isDeclaredOpName('')).toBe(false);
    expect(TELEMETRY_OP_NAMES.size).toBe(MCP_TOOLS.length + Object.keys(NON_CATALOG_OPS).length);
  });
});

describe('the analytics reads stay REST-only (D17)', () => {
  // Six as of migration 00079/00080's read-ranking endpoint — the decision's
  // ORIGINAL five plus one, not a re-litigation of it: `memory.read-ranking`
  // is the same "name-bearing scope-leak surface nothing agent-side asked
  // for" shape as `tags`/`facets`/`activity`, so it is added to the SAME
  // guarded set rather than exempted from it. See docs/decisions.md →
  // "Dashboard analytics reads stay REST-only".
  const RESTONLY_NAMES = [
    'memory.activity',
    'memory.facets',
    'memory.read-activity',
    'memory.read-ranking',
    'memory.tags',
    'memory.usage',
  ];

  it('records exactly these six as a decision, by name', () => {
    expect([...REST_ONLY_OP_NAMES].sort()).toEqual(RESTONLY_NAMES);
  });

  it('keeps memory.relevant OUT of the six — it is already covered agent-side', () => {
    // The near-miss, and the reason `restOnly` is a separate field rather than
    // "has no MCP tool". `GET /memories/relevant` has no tool of its own, but
    // the CAPABILITY is on the agent surface twice over (`memory.list
    // order=rank`, and `remote.relevant()` in the hook path), so it is not an
    // absence anybody decided on. Folding it in would make the decision claim
    // agents cannot rank lessons, which is false.
    expect(NON_CATALOG_OPS['memory.relevant']).toBeDefined();
    expect(NON_CATALOG_OPS['memory.relevant']?.restOnly).toBeUndefined();
    expect(REST_ONLY_OP_NAMES).not.toContain('memory.relevant');
  });

  it('gives none of the five an MCP tool', () => {
    const catalogued = new Set(MCP_TOOLS.map((t) => t.name));
    for (const name of REST_ONLY_OP_NAMES) {
      expect(catalogued.has(name), `${name} is REST-only but the catalog now declares a tool`).toBe(false);
    }
  });

  it('gives none of the five a CLI command either', () => {
    // Scanned rather than reasoned about: the CLI is free to call any REST
    // endpoint directly (it has no catalog dependency), so "no MCP tool"
    // does not imply "no CLI command". `/relevant` is the proof the scan
    // works — it IS called, from the hook path.
    const sources = cliSources();
    expect(sources.length, 'found no CLI sources to scan').toBeGreaterThan(20);

    const hay = sources.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');

    // Anti-vacuity, and the tightest available: the same pattern shape, on the
    // endpoint that must be present. If this fails, every negative below is
    // meaningless.
    expect(hay, 'the scan found no /memories/relevant call — the pattern is broken').toContain(
      '/memories/relevant',
    );

    for (const endpoint of ['/memories/usage', '/memories/tags', '/memories/facets',
      '/memories/activity', '/memories/read-activity']) {
      expect(hay.includes(endpoint), `a CLI command now calls ${endpoint}`).toBe(false);
    }
  });

  it('keeps the prose record alongside the annotation', () => {
    // The field says WHICH; the decision record says WHY, at a length no
    // field should carry. Losing either one leaves the other unexplained.
    const decisions = readFileSync(path.join(repoRoot, 'docs/decisions.md'), 'utf8');
    expect(decisions).toContain('## Dashboard analytics reads stay REST-only');
    for (const route of ['/memories/usage', '/tags', '/facets', '/activity', '/read-activity']) {
      expect(decisions, `the decision record no longer names ${route}`).toContain(route);
    }
  });
});

/** Every `.mjs` under `packages/cli/src`, recursively. */
function cliSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith('.mjs') ? [full] : [];
    });
  return walk(path.join(repoRoot, 'packages/cli/src'));
}

/**
 * Drop comments so a prose mention is not read as a call.
 *
 * Only LINE-LEADING `//` is stripped, never mid-line: the CLI source is full of
 * `https://` inside strings, and a naive `//`-to-EOL strip would truncate the
 * lines most likely to hold the endpoint being looked for — turning a false
 * positive into the far worse false negative.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}
