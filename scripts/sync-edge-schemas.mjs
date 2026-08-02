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
 *   node scripts/sync-edge-schemas.mjs           # write the mirror
 *   node scripts/sync-edge-schemas.mjs --check   # fail if it is stale
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(repoRoot, 'packages/schemas/src');
const mirrorDir = join(repoRoot, 'supabase/functions/_shared/schemas');

/**
 * The files the edge functions actually reach, source-relative.
 *
 * Deliberately NOT the whole package: `index.ts` is a barrel no function
 * imports, and `openapi/generate.ts` is a build script that imports `node:fs`.
 * Mirroring only what is reachable keeps the copied surface minimal.
 */
export const MIRRORED_SCHEMA_FILES = [
  'audit.ts',
  'common.ts',
  'filter.ts',
  'tags.ts',
  'scope.ts',
  'tool-catalog.ts',
  'memory.ts',
  'org.ts',
  'member.ts',
  'invite.ts',
  'usage.ts',
  'openapi/spec.ts',
];

/** Bare specifier → the explicit `npm:` form Deno resolves without a map. */
export const NPM_SPECIFIERS = {
  zod: 'npm:zod@3',
  '@asteasolutions/zod-to-openapi': 'npm:@asteasolutions/zod-to-openapi@^7.0.0',
};

const BANNER = `// GENERATED MIRROR — do not edit.
// Source: packages/schemas/src/{rel}
// Regenerate: node scripts/sync-edge-schemas.mjs
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

/** The exact content the mirror of `rel` should have. */
export function expectedMirror(rel, source) {
  return BANNER.replace('{rel}', rel) + toEdgeSource(source);
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];

  for (const rel of MIRRORED_SCHEMA_FILES) {
    const from = join(sourceDir, rel);
    const to = join(mirrorDir, rel);
    const expected = expectedMirror(rel, readFileSync(from, 'utf8'));

    if (check) {
      if (!existsSync(to) || readFileSync(to, 'utf8') !== expected) stale.push(rel);
      continue;
    }

    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, expected);
  }

  if (check && stale.length) {
    console.error(
      `Edge schema mirror is stale for:\n  ${stale.join('\n  ')}\n` +
        'Run: node scripts/sync-edge-schemas.mjs',
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
