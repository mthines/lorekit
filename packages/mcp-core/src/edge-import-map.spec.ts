import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guard for `supabase/functions/import_map.json`.
 *
 * The edge functions import shared Zod schemas by bare specifier
 * (`@lorekit/schemas/memory`) and the import map points those at
 * `../../packages/schemas/src/*.ts` — a path OUTSIDE the `supabase/`
 * directory. `supabase start` therefore has to bind-mount each of those source
 * files into the edge-runtime container, and it discovers them by walking the
 * import graph and substituting import-map keys (Supabase CLI,
 * `pkg/function.ImportMap.WalkImportPaths`).
 *
 * That walker has two properties this guard exists to protect against:
 *
 *  1. It applies EVERY key whose text is a prefix of the specifier, iterating a
 *     Go map — i.e. in randomised order — instead of taking the longest match
 *     the import-map spec mandates. With both `@lorekit/schemas` and
 *     `@lorekit/schemas/memory` present, `@lorekit/schemas/memory` can be
 *     rewritten to `./packages/schemas/src/index.ts/memory`, which has no file
 *     extension and is silently dropped from the mount set. Deno inside the
 *     container still resolves the specifier correctly (it does use longest
 *     match) — but to a file that was never mounted, so the worker dies with
 *     `BOOT_ERROR: Worker failed to boot`.
 *
 *  2. It only substitutes exact textual prefixes, so a trailing-slash
 *     "directory" mapping resolves to an extension-less path and is dropped
 *     too.
 *
 * Both failure modes disappear when the map contains exactly one entry per
 * specifier actually imported, and no key is a strict prefix of another. This
 * suite asserts precisely that, plus the obvious "every specifier we import is
 * mapped, and every mapped file exists".
 *
 * See https://github.com/mthines/lorekit — CI job "Integration smoke (local
 * Supabase)". This is the third import-map fix in the same file (#236, #240);
 * the guard is what stops the fourth.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../..');
const functionsDir = path.join(repoRoot, 'supabase', 'functions');
const importMapPath = path.join(functionsDir, 'import_map.json');

interface ImportMap {
  imports: Record<string, string>;
}

const importMap = JSON.parse(readFileSync(importMapPath, 'utf8')) as ImportMap;
const keys = Object.keys(importMap.imports);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Bare specifiers (not relative, not a URL, not an `npm:`/`node:` scheme) used
// by any edge-function source file.
const SPECIFIER_PATTERN = /\bfrom\s*['"]([^'"\n]+)['"]/g;

function bareSpecifiers(): Set<string> {
  const found = new Set<string>();
  for (const file of walkTsFiles(functionsDir)) {
    const source = readFileSync(file, 'utf8');
    SPECIFIER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPECIFIER_PATTERN.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (/^[a-z]+:/.test(specifier)) continue; // npm:, node:, https:
      found.add(specifier);
    }
  }
  return found;
}

describe('supabase/functions/import_map.json', () => {
  it('has no key that is a strict prefix of another key', () => {
    const collisions: string[] = [];
    for (const outer of keys) {
      for (const inner of keys) {
        if (outer !== inner && inner.startsWith(outer)) {
          collisions.push(`"${outer}" is a prefix of "${inner}"`);
        }
      }
    }
    // A prefix collision makes the Supabase CLI's bind-mount walker pick a key
    // at random, which intermittently drops real modules from the container.
    expect(collisions).toEqual([]);
  });

  it('maps every bare specifier the edge functions actually import', () => {
    const unmapped = [...bareSpecifiers()].filter((specifier) => !keys.includes(specifier));
    expect(unmapped).toEqual([]);
  });

  // The map is not only a resolver config — for `supabase start` it doubles as the
  // bind-mount manifest. The walker mounts the files it can name from the map; a file
  // pulled in only by a RELATIVE import inside an out-of-tree package (e.g.
  // `packages/schemas/src/memory.ts` importing `./scope.ts`) is never named, so it is
  // never mounted, and the worker dies with BOOT_ERROR even though Deno would resolve
  // it fine. Every file transitively reachable from a mapped entry must therefore be
  // mapped in its own right, whether or not any edge function imports it by specifier.
  it('maps every file transitively reachable from a mapped local entry', () => {
    const mapped = new Set(
      Object.values(importMap.imports)
        .filter((t) => t.startsWith('.') || t.startsWith('/'))
        .filter((t) => t.endsWith('.ts'))
        .map((t) => path.resolve(functionsDir, t)),
    );

    const seen = new Set<string>();
    const queue = [...mapped];
    const unmapped: string[] = [];

    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!mapped.has(file)) unmapped.push(path.relative(repoRoot, file));

      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue; // "file exists" is asserted by the next test
      }
      for (const match of source.matchAll(/\bfrom\s*['"](\.[^'"\n]+)['"]/g)) {
        queue.push(path.resolve(path.dirname(file), match[1]!));
      }
    }

    expect(
      unmapped.sort(),
      `these files are reachable only via a relative import and will not be bind-mounted by \`supabase start\` — add an import_map.json entry for each:\n  ${unmapped.join('\n  ')}`,
    ).toEqual([]);
  });

  it('resolves every mapped local path to a file that exists', () => {
    const missing: string[] = [];
    for (const [key, target] of Object.entries(importMap.imports)) {
      if (!target.startsWith('.') && !target.startsWith('/')) continue; // npm: etc.
      const resolved = path.resolve(functionsDir, target);
      const wantDirectory = target.endsWith('/');
      try {
        const stats = statSync(resolved);
        if (wantDirectory && !stats.isDirectory()) missing.push(`${key} -> ${target} (not a directory)`);
        if (!wantDirectory && !stats.isFile()) missing.push(`${key} -> ${target} (not a file)`);
      } catch {
        missing.push(`${key} -> ${target} (does not exist)`);
      }
    }
    expect(missing).toEqual([]);
  });
});
