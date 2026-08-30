import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Boot guard for the edge functions' module graph.
 *
 * The bug this exists to prevent recurring
 * ----------------------------------------
 * `memories`, `orgs` and `openapi` imported `@lorekit/schemas/*` and `zod` as
 * BARE specifiers. Those only resolve if something hands Deno an import map.
 * Nothing did: `supabase/functions/import_map.json` was present and correct but
 * auto-discovery of that filename was dropped by newer Supabase CLI versions,
 * and `setup-cli` pins `version: latest`, so the behaviour changed with no
 * commit to blame. Every one of those three functions died at boot with
 *
 *   failed to create the graph: Relative import path "@lorekit/schemas/memory"
 *   not prefixed with / or ./ or ../
 *
 * which reaches the caller only as an opaque `503 BOOT_ERROR: Worker failed to
 * boot`. It took six CI runs across five branches to see the real message,
 * because nothing dumped the edge-runtime container log.
 *
 * Declaring `import_map` per function in `config.toml` was then tried and did
 * NOT reach the local `supabase start` runtime — the error came back
 * byte-identical. So the fix removed the dependency instead: the schemas are
 * mirrored into `supabase/functions/_shared/schemas/` and every specifier is
 * now relative or fully qualified.
 *
 * The invariant
 * -------------
 * **No file reachable from an edge function may use a bare specifier.** Only
 * relative paths and fully-qualified `npm:` / `jsr:` / `node:` / URL specifiers
 * are allowed — the set Deno resolves with no configuration whatsoever. That is
 * strictly stronger than "the map is correct" and, unlike the map, it cannot be
 * silently disabled by a CLI upgrade.
 *
 * A pure source scan: no Deno, no Docker, no running stack — so it executes in
 * the mocked `check` job on every PR, not just the ones that boot Supabase.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const functionsDir = path.join(repoRoot, 'supabase/functions');

/** Specifiers Deno resolves with no import map and no config file. */
function isSelfResolving(specifier: string): boolean {
  return /^(\.{1,2}\/|\/|npm:|jsr:|node:|https?:|data:)/.test(specifier);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function importedSpecifiers(source: string): string[] {
  // Anchored to real import/export statements, with the specifier forbidden
  // from spanning a newline. A loose /from ['"](...)['"]/ matches prose inside
  // the SQL string builders in `_shared/telemetry/otel.ts` and swallows whole functions.
  const src = stripComments(source);
  const found = new Set<string>();
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/g, // import/export … from '…'
    /(?:^|[\s;}])import\s*['"]([^'"\n]+)['"]/g, // side-effect import '…'
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // dynamic import('…')
  ];
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found];
}

/** Deployable function slugs — every directory with an index.ts, minus `_shared`. */
function functionSlugs(): string[] {
  return readdirSync(functionsDir)
    .filter((name) => !name.startsWith('_'))
    .filter((name) => statSync(path.join(functionsDir, name)).isDirectory())
    .filter((name) => existsSync(path.join(functionsDir, name, 'index.ts')))
    .sort();
}

interface GraphResult {
  /** Bare specifiers found, as `file → specifier`. */
  bare: string[];
  /** Relative imports whose target is missing on disk, as `file → specifier`. */
  missing: string[];
  /** Every file visited. */
  visited: Set<string>;
}

/**
 * Walk one function's module graph the way the runtime does.
 *
 * Follows relative imports across directories (notably into `_shared/`), which
 * is where a bad import would otherwise hide — the original failure was in
 * `_shared/api/validate.ts` and `memories/handlers/*.ts`, not in an entrypoint.
 */
function walkGraph(entry: string): GraphResult {
  const bare: string[] = [];
  const missing: string[] = [];
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (!existsSync(file)) continue;

    const rel = path.relative(repoRoot, file);
    for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (!existsSync(target)) missing.push(`${rel} → ${specifier}`);
        queue.push(target);
        continue;
      }
      if (!isSelfResolving(specifier)) bare.push(`${rel} → ${specifier}`);
    }
  }
  return { bare, missing, visited };
}

describe('edge function module graph', () => {
  const slugs = functionSlugs();

  it('finds the deployable functions', () => {
    expect(slugs.length).toBeGreaterThan(0);
    // The five that exist today. A new one is fine — this asserts the scan is
    // actually reaching the tree, not that the list is frozen.
    expect(slugs).toEqual(expect.arrayContaining(['health', 'mcp', 'memories', 'openapi', 'orgs']));
  });

  // THE rule. Everything else in this file supports it.
  it.each(functionSlugs())(
    '%s boots without an import map — every specifier is self-resolving',
    (slug) => {
      const { bare } = walkGraph(path.join(functionsDir, slug, 'index.ts'));
      expect(bare).toEqual([]);
    },
  );

  it.each(functionSlugs())('%s imports only files that exist on disk', (slug) => {
    const { missing } = walkGraph(path.join(functionsDir, slug, 'index.ts'));
    expect(missing).toEqual([]);
  });

  // No function may reach outside `supabase/` for source. Reaching out is what
  // required the import map in the first place, and it is also what makes the
  // CLI's bind-mount walker relevant — mounts it can silently fail to create.
  it.each(functionSlugs())('%s reaches no source outside supabase/functions', (slug) => {
    const { visited } = walkGraph(path.join(functionsDir, slug, 'index.ts'));
    const outside = [...visited]
      .filter((file) => existsSync(file))
      .filter((file) => !file.startsWith(functionsDir + path.sep))
      .map((file) => path.relative(repoRoot, file));
    expect(outside).toEqual([]);
  });

  // The import map is gone; nothing may quietly reintroduce a reference to it.
  it('has no import_map declaration left in config.toml', () => {
    const config = readFileSync(path.join(repoRoot, 'supabase/config.toml'), 'utf8');
    expect(config).not.toMatch(/^\s*import_map\s*=/m);
  });
});
