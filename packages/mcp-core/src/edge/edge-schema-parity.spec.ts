import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard for the edge copy of `@lorekit/schemas`.
 *
 * `supabase/functions/_shared/schemas/**` is a generated mirror of
 * `packages/schemas/src/**` — the same pattern as the `limits.ts`,
 * `permissions.ts`, `tenant-scope.ts` and `audit.ts` mirrors, for the same
 * reason: edge functions are self-contained Deno and cannot import across
 * packages without an import map, which the local runtime is not given.
 *
 * Duplication is only safe while it is enforced. If someone edits
 * `packages/schemas` and forgets `node scripts/sync-edge-schemas.mjs`, this
 * fails in the mocked `check` job — not at boot, in CI, three PRs later.
 *
 * The generator is invoked as a subprocess rather than imported: it lives
 * outside this package, and `@nx/enforce-module-boundaries` rightly refuses a
 * relative import across that line. Shelling out also means the test exercises
 * the real script a developer runs, not a copy of its logic.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const sourceDir = path.join(repoRoot, 'packages/schemas/src');
const mirrorDir = path.join(repoRoot, 'supabase/functions/_shared/schemas');

/** Bare specifier → the fully-qualified form the mirror substitutes. */
const NPM_SPECIFIERS: Record<string, string> = {
  zod: 'npm:zod@3',
  '@asteasolutions/zod-to-openapi': 'npm:@asteasolutions/zod-to-openapi@^7.0.0',
};

/** Mirrored files, discovered from disk (source-relative paths). */
function mirroredFiles(dir = mirrorDir, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory() ? mirroredFiles(full, rel) : rel.endsWith('.ts') ? [rel] : [];
  });
}

const files = mirroredFiles();

/** Strip the generated banner: every leading `//` line up to the first blank or code line. */
function stripBanner(source: string): string {
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('// ') && !lines[i]!.startsWith('// deno-lint')) i++;
  return lines.slice(i).join('\n');
}

/**
 * The mirror is deliberately FLAT (`memory.ts`) even though
 * `packages/schemas/src/` is organised into `domain/`/`shared/`
 * subdirectories, so a mirrored file's relative path no longer names its
 * source's relative path. The banner's `// Source: packages/schemas/src/{rel}`
 * line is the one place that mapping is recorded — read it from there rather
 * than duplicating `sync-edge-schemas.mjs`'s FROM/TO list (which
 * `@nx/enforce-module-boundaries` would refuse to import here anyway) or
 * assuming the two trees are symmetric.
 */
function sourceRelFromBanner(mirror: string): string | null {
  const match = /^\/\/ Source: packages\/schemas\/src\/(.+)$/m.exec(mirror);
  return match ? match[1]! : null;
}

const noExt = (p: string) => p.replace(/\.ts$/, '');

/**
 * source-relative (no extension) → mirror-relative (no extension), discovered
 * from every mirror's own banner rather than duplicating
 * `sync-edge-schemas.mjs`'s FROM/TO list (see `sourceRelFromBanner` above for
 * why this file cannot just import it).
 */
const mirrorRelBySource = new Map(
  files.map((mirrorRel) => {
    const sourceRel = sourceRelFromBanner(readFileSync(path.join(mirrorDir, mirrorRel), 'utf8'));
    return [sourceRel ? noExt(sourceRel) : null, noExt(mirrorRel)] as const;
  }),
);

/**
 * Reshape a relative import in SOURCE content to point at the flat MIRROR
 * layout, the same transform `sync-edge-schemas.mjs`'s `rewriteRelativeImports`
 * applies when it generates the mirror. Needed because `packages/schemas/src/`
 * is nested (`domain/`, `shared/`) while the mirror stays flat, so a source
 * file's relative imports are legitimately NOT byte-identical to its mirror's
 * — only the resolved TARGET must agree.
 */
function reshapeToMirror(source: string, sourceRel: string): string {
  const sourceDirRel = path.posix.dirname(sourceRel);
  const mirrorDirRel = path.posix.dirname(mirrorRelBySource.get(noExt(sourceRel))!);
  return source.replace(/from\s+(["'])(\.[^"']+)\1/g, (full, quote, spec) => {
    const targetSourceRel = path.posix.normalize(path.posix.join(sourceDirRel, spec));
    const targetMirrorRel = mirrorRelBySource.get(noExt(targetSourceRel));
    if (targetMirrorRel === undefined) return full; // not a mirrored file; leave untouched
    const ext = path.posix.extname(spec) || '.ts';
    let rel = path.posix.relative(mirrorDirRel, targetMirrorRel);
    if (!rel.startsWith('.')) rel = './' + rel;
    return `from ${quote}${rel}${ext}${quote}`;
  });
}

describe('edge schema mirror', () => {
  it('mirrors a non-empty set of files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // The authoritative check: the committed mirror is exactly what the
  // generator would produce from the current source.
  it('is in sync with packages/schemas (scripts/sync-edge-schemas.mjs --check)', () => {
    expect(() =>
      execFileSync('node', ['scripts/sync-edge-schemas.mjs', '--check'], {
        cwd: repoRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it.each(files)('%s carries a resolvable Source: banner', (rel: string) => {
    const mirror = readFileSync(path.join(mirrorDir, rel), 'utf8');
    const sourceRel = sourceRelFromBanner(mirror);
    expect(sourceRel, `${rel} has no "// Source: packages/schemas/src/..." banner line`).not.toBeNull();
    expect(existsSync(path.join(sourceDir, sourceRel!))).toBe(true);
  });

  // Stated independently of the generator so the contract is readable here:
  // the only permitted differences are the bare → `npm:` specifier rewrite and
  // a relative import reshaped for the mirror's flat layout (see
  // `reshapeToMirror` — the two trees are no longer symmetric, so this is
  // "resolves to the same file", not "byte-identical text").
  it.each(files)('%s differs from its source only by the npm: rewrite and mirror-flat imports', (rel: string) => {
    const mirror = readFileSync(path.join(mirrorDir, rel), 'utf8');
    const sourceRel = sourceRelFromBanner(mirror)!;
    const source = readFileSync(path.join(sourceDir, sourceRel), 'utf8');

    let normalised = stripBanner(mirror);
    for (const [bare, npm] of Object.entries(NPM_SPECIFIERS)) {
      normalised = normalised.split(`'${npm}'`).join(`'${bare}'`);
    }
    expect(normalised).toBe(reshapeToMirror(source, sourceRel));
  });

  it.each(files)('%s carries the do-not-edit banner', (rel: string) => {
    expect(readFileSync(path.join(mirrorDir, rel), 'utf8')).toMatch(/^\/\/ GENERATED MIRROR/);
  });

  it('leaves no bare specifier in the mirrored files', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const mirror = readFileSync(path.join(mirrorDir, rel), 'utf8');
      for (const match of mirror.matchAll(/from\s+['"]([^'"\n]+)['"]/g)) {
        const specifier = match[1]!;
        if (!/^(\.{1,2}\/|\/|npm:|jsr:|node:|https?:|data:)/.test(specifier)) {
          offenders.push(`${rel} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
