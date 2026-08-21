#!/usr/bin/env node
/**
 * Emit the surface artifacts that cannot simply IMPORT the tool catalog.
 *
 * Why a generator at all
 * ---------------------
 * `packages/schemas/src/tool-catalog.ts` is the single origin of LoreKit's
 * operation surface. Most consumers just import it — the edge function reads
 * the mirrored copy, `mcp-core` imports the package — and an import has no
 * staleness surface at all, so it needs no generator and no `--check`.
 *
 * Two consumers cannot import it, and those are the only ones served here:
 *
 *   1. `@lorekit/cli` is a PUBLISHED, zero-dependency npm package. It ships
 *      `bin` + `src` and has no `dependencies` at all, so importing the
 *      workspace `@lorekit/schemas` would break the published artifact. It gets
 *      a committed, zero-dep `.mjs` data module inside `src/`.
 *   2. The edge MCP dispatch map has to bind each op NAME to an imported
 *      FUNCTION. The catalog is zero-import by construction (a `zod` or
 *      relative import would break both the edge mirror parity and this
 *      script's bare-checkout contract), so it can only name the handler. The
 *      generated module does the importing. (Added in a later commit.)
 *
 * Structure mirrors `scripts/sync-edge-schemas.mjs` deliberately — pure
 * exported transforms, a `main()`, a `--check` staleness mode that exits 1, and
 * a self-invoke guard — so the two generators are read and maintained the same
 * way. The one difference: that script reads its source as TEXT and rewrites
 * specifiers, while this one `import()`s the catalog and projects real data.
 *
 * Usage:
 *   node scripts/gen-surfaces.mjs           # write the artifacts
 *   node scripts/gen-surfaces.mjs --check   # fail if any is stale
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(repoRoot, 'packages/schemas/src/tool-catalog.ts');

/**
 * Minimum Node for THIS SCRIPT: it `import()`s a `.ts` file and relies on
 * native type stripping, which is on by default from 22.18.0. Below that the
 * failure is an opaque syntax error pointing inside the catalog, which sends
 * you looking for a bug in a file that is fine — so fail loudly instead.
 *
 * Note this is NOT the constraint on what we EMIT. `@lorekit/cli` declares
 * `engines.node >= 18`, so the generated artifact must be plain ESM data that
 * runs on 18. This floor applies only to the dev/CI process running the
 * generator.
 */
const MIN_NODE = [22, 18, 0];

function assertNodeSupportsTypeStripping() {
  const actual = process.versions.node.split('.').map(Number);
  const ok =
    actual[0] > MIN_NODE[0] ||
    (actual[0] === MIN_NODE[0] && actual[1] >= MIN_NODE[1]);
  if (ok) return;
  console.error(
    `gen-surfaces.mjs needs Node >= ${MIN_NODE.join('.')} (found ${process.versions.node}).\n` +
      'It imports packages/schemas/src/tool-catalog.ts directly and relies on native\n' +
      'TypeScript type stripping, which is enabled by default from 22.18.0.\n' +
      'Upgrade Node, or run it under the version CI pins (see .github/workflows/ci.yml).',
  );
  process.exit(1);
}

/** Load the catalog. Async because it is a dynamic `import()` of a `.ts` file. */
export async function loadCatalog() {
  return import(pathToFileURL(catalogPath).href);
}

const BANNER = `// GENERATED — do not edit.
// Source: packages/schemas/src/tool-catalog.ts
// Regenerate: node scripts/gen-surfaces.mjs
//
// Edit the catalog's \`surfaces\` bindings, not this file. \`--check\` fails CI
// when the two disagree.
`;

/** Stable, readable literal for embedding in generated source. */
function literal(value, indent = 0) {
  const pad = ' '.repeat(indent);
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

/**
 * The CLI's zero-dep data module.
 *
 * Only DATA — no behaviour, no imports — so it is safe in a published package
 * on the CLI's Node 18 engine floor, and so the hand-written command registry
 * stays the only place CLI behaviour is decided.
 */
export function renderCliSurfaces(catalog) {
  const { MCP_TOOLS, wireTools, PURGE_RETENTION_DAYS_DEFAULT } = catalog;

  const memory = MCP_TOOLS.filter((t) => t.name.startsWith('memory.')).map((t) => t.name);
  const org = MCP_TOOLS.filter((t) => t.name.startsWith('org.')).map((t) => t.name);

  const bindings = {};
  const aliases = {};
  const cliExempt = {};
  const localMcpExempt = {};
  for (const tool of MCP_TOOLS) {
    const s = tool.surfaces;
    if (s.cli) {
      bindings[s.cli] = tool.name;
      for (const alias of s.cliAliases ?? []) aliases[alias] = s.cli;
    }
    if (s.cliExempt) cliExempt[tool.name] = s.cliExempt;
    if (s.localMcpExempt) localMcpExempt[tool.name] = s.localMcpExempt;
  }

  return `${BANNER}
/** Every catalog op, in \`tools/list\` wire order. */
export const MCP_TOOL_NAMES = ${literal(MCP_TOOLS.map((t) => t.name))};

/** The \`memory.*\` family — dispatched against a store (local or remote). */
export const MEMORY_TOOL_NAMES = ${literal(memory)};

/** The \`org.*\` family — always proxied to the REST API, never the local store. */
export const ORG_TOOL_NAMES = ${literal(org)};

/**
 * The \`tools/list\` payload: name, description and inputSchema per op.
 * Identical projection to the edge server's, from the same declaration, so the
 * local stdio server and the hosted server advertise the same contract.
 */
export const MCP_TOOL_DEFS = ${literal(wireTools(), 0)};

/** CLI command name -> the catalog op it invokes. */
export const CLI_BINDINGS = ${literal(bindings)};

/** CLI alias -> canonical command name. */
export const CLI_ALIASES = ${literal(aliases)};

/**
 * Op -> why it has NO CLI command. A declared exemption, so absence from the
 * CLI is a reviewable decision rather than an oversight.
 */
export const CLI_EXEMPT = ${literal(cliExempt)};

/** Op -> why the local stdio MCP server does not dispatch it. */
export const LOCAL_MCP_EXEMPT = ${literal(localMcpExempt)};

/**
 * Default retention window for \`memory.purge\`, in days.
 *
 * Derived rather than restated: this value appears in the tool description the
 * server advertises, in the CLI's help text, and in the CLI's client-side
 * validation. Three hand-written copies of one number is three chances for the
 * help to promise a default the server does not apply.
 */
export const PURGE_RETENTION_DAYS_DEFAULT = ${JSON.stringify(PURGE_RETENTION_DAYS_DEFAULT)};
`;
}

/**
 * The edge MCP dispatch maps.
 *
 * This is the one place generation is genuinely unavoidable: the map has to
 * bind each op NAME to an imported FUNCTION, and the catalog is zero-import so
 * it can only hold the name. The generated module does the importing.
 *
 * `satisfies Record<MemoryToolName, unknown>` is what makes this worth
 * generating rather than asserting. It checks the KEY SET exactly — a missing op
 * fails because `Record` requires every key, an extra one fails as an excess
 * property — so catalog↔dispatch agreement becomes a compile error instead of a
 * source-scraping regex. The value type stays `unknown` on purpose: the two
 * families have different call signatures, and constraining them here would
 * duplicate a contract that `tools.ts` already states.
 */
export function renderEdgeDispatch(catalog) {
  const { MCP_TOOLS } = catalog;
  const memory = MCP_TOOLS.filter((t) => t.name.startsWith('memory.'));
  const org = MCP_TOOLS.filter((t) => t.name.startsWith('org.'));

  const imports = MCP_TOOLS.map((t) => `  ${t.surfaces.handler},`).join('\n');
  const entry = (t) => `  '${t.name}': ${t.surfaces.handler},`;

  return `${BANNER}
import {
${imports}
} from './tools.ts';
import type { MemoryToolName, OrgToolName } from '../_shared/schemas/tool-catalog.ts';

// memory.* tools — dispatched with (db, args, userId, span, keyScoping).
export const MEMORY_TOOLS = {
${memory.map(entry).join('\n')}
} as const satisfies Record<MemoryToolName, unknown>;

// org.* tools — dispatched with (db, args, userId, span), the same shape as
// the memory family so the dispatcher threads the actor one way.
export const ORG_TOOLS = {
${org.map(entry).join('\n')}
} as const satisfies Record<OrgToolName, unknown>;

/** Every dispatchable name — the unknown-tool guard in \`tools/call\`. */
export const ALL_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(MEMORY_TOOLS),
  ...Object.keys(ORG_TOOLS),
]);
`;
}

/**
 * Every artifact this generator owns: where it goes and how it is rendered.
 * Exported so a spec can assert the set rather than rediscovering it.
 */
export const GENERATED_TARGETS = [
  { path: 'packages/cli/src/surfaces.generated.mjs', render: renderCliSurfaces },
  { path: 'supabase/functions/mcp/tool-dispatch.generated.ts', render: renderEdgeDispatch },
];

async function main() {
  assertNodeSupportsTypeStripping();
  const check = process.argv.includes('--check');
  const catalog = await loadCatalog();
  const stale = [];

  for (const target of GENERATED_TARGETS) {
    const to = join(repoRoot, target.path);
    const expected = target.render(catalog);

    if (check) {
      if (!existsSync(to) || readFileSync(to, 'utf8') !== expected) stale.push(target.path);
      continue;
    }

    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, expected);
  }

  if (check && stale.length) {
    console.error(
      `Generated surface artifacts are stale:\n  ${stale.join('\n  ')}\n` +
        'Run: node scripts/gen-surfaces.mjs',
    );
    process.exit(1);
  }
  console.log(
    check
      ? `Surface artifacts are in sync (${GENERATED_TARGETS.length} files).`
      : `Generated ${GENERATED_TARGETS.length} surface artifact(s).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
