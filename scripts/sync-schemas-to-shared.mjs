/**
 * Copy @lorekit/schemas source files into supabase/functions/_shared/schemas/.
 *
 * The Supabase Edge Function bundler cannot import from outside the function's
 * own directory tree via deno.json at deploy time (local relative paths work at
 * serve time, but the deploy bundler packages only the function directory).
 *
 * This script is the build-time solution: it copies packages/schemas/src/ into
 * supabase/functions/_shared/schemas/ so the Deno runtime can resolve schemas
 * with a relative import like `../_shared/schemas/memory.ts`.
 *
 * The _shared/schemas/ directory is GENERATED OUTPUT.
 * Always edit packages/schemas/src/ and re-run this script.
 *
 * Usage:
 *   node scripts/sync-schemas-to-shared.mjs
 *   pnpm nx sync-to-shared schemas
 *
 * Wired into NX via packages/schemas/project.json — runs before supabase deploy.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'packages', 'schemas', 'src');
const dest = join(root, 'supabase', 'functions', '_shared', 'schemas');

mkdirSync(dest, { recursive: true });

cpSync(src, dest, {
  recursive: true,
  filter: (srcPath) => {
    // Exclude openapi generation tooling — not needed at runtime
    if (srcPath.includes(`${join('src', 'openapi')}`)) return false;
    // Exclude test files
    if (srcPath.endsWith('.spec.ts') || srcPath.endsWith('.test.ts')) return false;
    return true;
  },
});

// Prepend generated header to the destination index.ts
const generatedHeader =
  '// AUTO-GENERATED — DO NOT EDIT.\n' +
  '// Source: packages/schemas/src/index.ts\n' +
  '// Regenerate: node scripts/sync-schemas-to-shared.mjs\n\n';

const indexSrc = readFileSync(join(src, 'index.ts'), 'utf-8');
writeFileSync(join(dest, 'index.ts'), generatedHeader + indexSrc, 'utf-8');

console.log(`Synced: packages/schemas/src/ → supabase/functions/_shared/schemas/`);
