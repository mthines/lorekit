import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard for the edge functions' import map.
 *
 * Background — the bug this exists to prevent recurring:
 *
 * `supabase/functions/import_map.json` was present and correct, but declared
 * NOWHERE. Older Supabase CLI versions auto-discovered that filename; current
 * ones do not, and `setup-cli` pins `version: latest`, so the behaviour changed
 * with no commit to blame. Deno therefore never received the map, and every
 * function importing a bare specifier died at boot with
 *
 *   failed to create the graph: Relative import path "@lorekit/schemas/memory"
 *   not prefixed with / or ./ or ../
 *
 * which reaches the caller only as an opaque `503 BOOT_ERROR: Worker failed to
 * boot`. It took five CI runs across four branches to see the real message,
 * because nothing dumped the edge-runtime container log. Rule #4 below is the
 * one that would have caught it on the first run.
 *
 * A pure source scan: no Deno, no Docker, no running stack — so it executes in
 * the mocked `check` job on every PR, not just the ones that boot Supabase.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const functionsDir = path.join(repoRoot, 'supabase/functions');
const importMapPath = path.join(functionsDir, 'import_map.json');
const configPath = path.join(repoRoot, 'supabase/config.toml');

const importMap = JSON.parse(readFileSync(importMapPath, 'utf8')) as {
  imports: Record<string, string>;
};
const config = readFileSync(configPath, 'utf8');

/** A specifier Deno cannot resolve without an import map. */
function isBareSpecifier(specifier: string): boolean {
  return !/^(\.{1,2}\/|\/|npm:|jsr:|node:|https?:|data:)/.test(specifier);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function importedSpecifiers(source: string): string[] {
  // Anchored to real import/export statements, with the specifier forbidden
  // from spanning a newline. A loose /from ['"](...)['"]/ matches prose inside
  // the SQL string builders in `_shared/otel.ts` and swallows whole functions.
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

/**
 * Walk one function's module graph the way the runtime does and collect every
 * bare specifier it transitively depends on.
 *
 * Follows relative imports across directories (notably into `_shared/`), and
 * follows a bare specifier that the map resolves to a local file (notably into
 * `packages/schemas/`) — so a new bare import added inside a mapped package is
 * caught here too, not at boot.
 */
function bareSpecifiersFor(entry: string): Set<string> {
  const bare = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(path.resolve(path.dirname(file), specifier));
        continue;
      }
      if (!isBareSpecifier(specifier)) continue;

      bare.add(specifier);
      const target = importMap.imports[specifier];
      if (target?.startsWith('.')) queue.push(path.resolve(functionsDir, target));
    }
  }
  return bare;
}

/** Deployable function slugs — every directory with an index.ts, minus `_shared`. */
function functionSlugs(): string[] {
  return readdirSync(functionsDir)
    .filter((name) => !name.startsWith('_'))
    .filter((name) => statSync(path.join(functionsDir, name)).isDirectory())
    .filter((name) => existsSync(path.join(functionsDir, name, 'index.ts')))
    .sort();
}

/** Does config.toml declare an `import_map` for this function? */
function declaresImportMap(slug: string): boolean {
  const section = config.split(`[functions.${slug}]`)[1];
  if (section === undefined) return false;
  // Stop at the next top-level table so a later function's key is not counted.
  // `[functions.<slug>.secrets]` is a sub-table and stays inside this slice.
  const body = section.split(/\n\[functions\.(?!\w+\.secrets)/)[0]!;
  return /^\s*import_map\s*=/m.test(body);
}

describe('edge function import map', () => {
  const slugs = functionSlugs();

  it('finds the deployable functions', () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  // Rule 1 — no key may be a strict prefix of another.
  //
  // The Supabase CLI's bind-mount walker applies EVERY prefix-matching key,
  // iterating a Go map in randomised order, instead of taking the longest
  // match the import-map spec mandates. With both `@lorekit/schemas` and
  // `@lorekit/schemas/memory` present, a short key can win the race and
  // produce an extension-less path the walker silently drops — an
  // intermittent missing bind mount. See the #242 analysis.
  it('has no key that is a strict prefix of another key', () => {
    const keys = Object.keys(importMap.imports);
    const collisions = keys.flatMap((key) =>
      keys.filter((other) => other !== key && other.startsWith(key)).map((other) => `${key} ⊂ ${other}`),
    );
    expect(collisions).toEqual([]);
  });

  // Rule 2 — every mapped local path must exist.
  it('maps only local paths that exist on disk', () => {
    const missing = Object.entries(importMap.imports)
      .filter(([, target]) => target.startsWith('.'))
      .filter(([, target]) => !existsSync(path.resolve(functionsDir, target)))
      .map(([key, target]) => `${key} -> ${target}`);
    expect(missing).toEqual([]);
  });

  // Rule 3 — every bare specifier a function transitively imports must have an
  // EXACT entry. Exact, not prefix: rule 1 forbids the directory-style keys
  // that would otherwise cover a subpath.
  it('maps every bare specifier the functions import', () => {
    const unmapped: string[] = [];
    for (const slug of slugs) {
      for (const specifier of bareSpecifiersFor(path.join(functionsDir, slug, 'index.ts'))) {
        if (!(specifier in importMap.imports)) unmapped.push(`${slug}: ${specifier}`);
      }
    }
    expect(unmapped).toEqual([]);
  });

  // Rule 4 — the one that would have caught the BOOT_ERROR on run one.
  //
  // A correct map that nothing points at is not applied. Any function whose
  // graph contains a bare specifier MUST declare `import_map` in config.toml,
  // or Deno resolves nothing and the worker dies at boot.
  it('declares import_map in config.toml for every function that needs one', () => {
    const undeclared = slugs
      .filter((slug) => bareSpecifiersFor(path.join(functionsDir, slug, 'index.ts')).size > 0)
      .filter((slug) => !declaresImportMap(slug));
    expect(undeclared).toEqual([]);
  });

  // Rule 5 — the converse, kept as documentation rather than enforcement:
  // a function with no bare specifiers needs no entry, and mcp/health
  // deliberately have none (self-contained, per CLAUDE.md).
  it('leaves the self-contained functions free of bare specifiers', () => {
    for (const slug of ['mcp', 'health']) {
      if (!slugs.includes(slug)) continue;
      expect([...bareSpecifiersFor(path.join(functionsDir, slug, 'index.ts'))]).toEqual([]);
    }
  });
});
