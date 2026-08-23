#!/usr/bin/env node
/**
 * Mirror `packages/schemas/src/**` into `supabase/functions/_shared/schemas/**`.
 *
 * Why a mirror instead of importing the package
 * ---------------------------------------------
 * Edge functions are self-contained Deno — the repo's standing rule, and the
 * same reason `limits.ts`, `permissions.ts`, `tenant-scope.ts`, `audit.ts` and
 * friends are already mirrored rather than imported. `memories`, `orgs` and
 * `openapi` broke that rule by importing `@lorekit/schemas/*` as a BARE
 * specifier, which only resolves if something hands Deno an import map.
 * Nothing did: current Supabase CLI versions no longer auto-discover
 * `supabase/functions/import_map.json`, and `setup-cli` pins `version: latest`,
 * so it changed with no commit to blame. Every one of those three functions
 * died at boot with
 *
 *   failed to create the graph: Relative import path "@lorekit/schemas/memory"
 *   not prefixed with / or ./ or ../
 *
 * surfacing to callers only as an opaque `503 BOOT_ERROR: Worker failed to
 * boot`. Mirroring removes the import map from the boot path entirely, so no
 * future CLI change can reintroduce this.
 *
 * The one transform
 * -----------------
 * Mirrored files are byte-identical to their source except that the bare
 * `zod` / `@asteasolutions/zod-to-openapi` specifiers become explicit `npm:`
 * ones, which Deno resolves without a map. `edge-schema-parity.spec.ts`
 * asserts exactly that relationship, so the copies cannot silently drift.
 *
 * Usage:
 *   node scripts/codegen/sync-edge-schemas.mjs           # write the mirror
 *   node scripts/codegen/sync-edge-schemas.mjs --check   # fail if it is stale
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDir = join(repoRoot, 'packages/schemas/src');
const mirrorDir = join(repoRoot, 'supabase/functions/_shared/schemas');

/**
 * The files the edge functions actually reach, as [source-relative, mirror-relative]
 * pairs.
 *
 * Deliberately NOT the whole package: `index.ts` is a barrel no function
 * imports, and `openapi/generate.ts` is a build script that imports `node:fs`.
 * Mirroring only what is reachable keeps the copied surface minimal.
 *
 * The mirror stays FLAT even though `packages/schemas/src/` is organised into
 * `domain/`/`shared/` subdirectories — the mirror is a generated artifact
 * nobody browses for structure, and keeping its layout stable means this
 * restructuring touches zero files under `supabase/functions/`.
 */
export const MIRRORED_SCHEMA_FILES = [
  ['domain/audit.ts', 'audit.ts'],
  ['domain/api-key.ts', 'api-key.ts'],
  ['shared/common.ts', 'common.ts'],
  ['shared/filter.ts', 'filter.ts'],
  ['shared/tags.ts', 'tags.ts'],
  ['shared/dimensions.ts', 'dimensions.ts'],
  ['shared/scope.ts', 'scope.ts'],
  ['shared/tool-catalog.ts', 'tool-catalog.ts'],
  ['domain/blog.ts', 'blog.ts'],
  ['domain/memory.ts', 'memory.ts'],
  ['domain/org.ts', 'org.ts'],
  ['domain/member.ts', 'member.ts'],
  ['domain/invite.ts', 'invite.ts'],
  ['domain/usage.ts', 'usage.ts'],
  ['shared/relevant.ts', 'relevant.ts'],
  ['openapi/spec.ts', 'openapi/spec.ts'],
];

/** Bare specifier → the explicit `npm:` form Deno resolves without a map. */
export const NPM_SPECIFIERS = {
  zod: 'npm:zod@3',
  '@asteasolutions/zod-to-openapi': 'npm:@asteasolutions/zod-to-openapi@^7.0.0',
};

const noExt = (p) => p.replace(/\.ts$/, '');

/** source-relative (no extension) → mirror-relative (no extension). */
const MIRROR_REL_BY_SOURCE = new Map(
  MIRRORED_SCHEMA_FILES.map(([sourceRel, mirrorRel]) => [noExt(sourceRel), noExt(mirrorRel)]),
);

/**
 * Rewrite a relative import so it points at the FLAT mirror layout instead of
 * the nested source layout. `packages/schemas/src/domain/memory.ts` imports
 * `../shared/scope.ts`; its mirror (`memory.ts`, flat) must import `./scope.ts`
 * instead — a byte-for-byte copy of the source specifier would resolve to a
 * `shared/` directory that does not exist beside the mirror. Only specifiers
 * that resolve to another file IN `MIRRORED_SCHEMA_FILES` are rewritten; a
 * relative import to anything else is a mirroring bug this throws on instead
 * of silently miscopying.
 */
export function rewriteRelativeImports(source, sourceRel) {
  const sourceDirRel = path.posix.dirname(sourceRel);
  const mirrorRel = MIRROR_REL_BY_SOURCE.get(noExt(sourceRel));
  const mirrorDirRel = path.posix.dirname(mirrorRel);

  return source.replace(/from\s+(["'])(\.[^"']+)\1/g, (full, quote, spec) => {
    const targetSourceRel = path.posix.normalize(path.posix.join(sourceDirRel, spec));
    const targetMirrorRel = MIRROR_REL_BY_SOURCE.get(noExt(targetSourceRel));
    if (targetMirrorRel === undefined) {
      throw new Error(
        `${sourceRel} imports '${spec}', which resolves to '${targetSourceRel}.ts' — ` +
          'not in MIRRORED_SCHEMA_FILES, so the mirror cannot follow it. Add it to the list.',
      );
    }
    const ext = path.posix.extname(spec) || '.ts';
    let rel = path.posix.relative(mirrorDirRel, targetMirrorRel);
    if (!rel.startsWith('.')) rel = './' + rel;
    return `from ${quote}${rel}${ext}${quote}`;
  });
}

const BANNER = `// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/{rel}
// Regenerate: node scripts/codegen/sync-edge-schemas.mjs
// Why: edge functions are self-contained Deno; a bare '@lorekit/schemas/*'
// specifier needs an import map, and the local edge runtime is not given one.
`;

/** Apply the bare → `npm:` specifier rewrite. Pure; exported for the spec. */
export function toEdgeSource(source) {
  let out = source;
  for (const [bare, npm] of Object.entries(NPM_SPECIFIERS)) {
    const pattern = new RegExp(`(from\\s+["'])${bare.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(["'])`, 'g');
    out = out.replace(pattern, `$1${npm}$2`);
  }
  return out;
}

/** The exact content the mirror of source-relative `sourceRel` should have. */
export function expectedMirror(sourceRel, source) {
  return BANNER.replace('{rel}', sourceRel) + toEdgeSource(rewriteRelativeImports(source, sourceRel));
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];

  for (const [sourceRel, mirrorRel] of MIRRORED_SCHEMA_FILES) {
    const from = join(sourceDir, sourceRel);
    const to = join(mirrorDir, mirrorRel);
    const expected = expectedMirror(sourceRel, readFileSync(from, 'utf8'));

    if (check) {
      if (!existsSync(to) || readFileSync(to, 'utf8') !== expected) stale.push(mirrorRel);
      continue;
    }

    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, expected);
  }

  if (check && stale.length) {
    console.error(
      `Edge schema mirror is stale for:\n  ${stale.join('\n  ')}\n` +
        'Run: node scripts/codegen/sync-edge-schemas.mjs',
    );
    process.exit(1);
  }
  console.log(
    check
      ? `Edge schema mirror is in sync (${MIRRORED_SCHEMA_FILES.length} files).`
      : `Mirrored ${MIRRORED_SCHEMA_FILES.length} schema files into supabase/functions/_shared/schemas/.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
