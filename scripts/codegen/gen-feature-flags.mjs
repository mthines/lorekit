#!/usr/bin/env node
/**
 * Emit the artifacts derived from `packages/feature-flags/src/registry.ts` —
 * the single hand-authored source of truth for every flag.
 *
 * Why a generator at all
 * ----------------------
 * `registry.ts` is TypeScript, validated by `FlagRegistrySchema` (zod) at
 * import time. Two consumers need a PROJECTION of it that a plain `import`
 * can't give them:
 *
 *   1. The TS client (`client.ts`) wants a compile-time union of flag keys
 *      and a per-key value type, so `evaluateFlag('typo-key', ...)` is a
 *      type error instead of a `FLAG_NOT_FOUND` discovered at runtime.
 *      `src/generated/flags.generated.ts` is that projection — TYPES only,
 *      re-exporting nothing the registry doesn't already export as values.
 *   2. Any OTHER language's OpenFeature SDK (Go, Python, Rust, ...) needs
 *      the flag catalog WITHOUT importing TypeScript at all.
 *      `generated/flags.manifest.json` is a plain, language-neutral
 *      manifest — every field `FlagDefinitionSchema` validates, serialised —
 *      that a per-language generator (not written yet; see
 *      `docs/feature-flags.md#adding-a-language`) reads to emit its own
 *      typed bindings. This is the mechanism "flags shared across languages"
 *      actually means: one manifest, N generators, each owned by the
 *      package/service that needs that language.
 *
 * Structure mirrors `scripts/codegen/gen-surfaces.mjs` deliberately — pure
 * exported render functions, a `main()`, a `--check` staleness mode that
 * exits 1, and a self-invoke guard.
 *
 * Usage:
 *   node scripts/codegen/gen-feature-flags.mjs           # write the artifacts
 *   node scripts/codegen/gen-feature-flags.mjs --check   # fail if stale
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const registryPath = join(repoRoot, 'packages/feature-flags/src/registry.ts');

/**
 * Minimum Node for THIS SCRIPT: it `import()`s `.ts` files directly and
 * relies on native type stripping (default from 22.18.0). This floor is on
 * the dev/CI process running the generator, not on what the generated files
 * require to run.
 */
const MIN_NODE = [22, 18, 0];

function assertNodeSupportsTypeStripping() {
  const actual = process.versions.node.split('.').map(Number);
  const ok = actual[0] > MIN_NODE[0] || (actual[0] === MIN_NODE[0] && actual[1] >= MIN_NODE[1]);
  if (ok) return;
  console.error(
    `gen-feature-flags.mjs needs Node >= ${MIN_NODE.join('.')} (found ${process.versions.node}).\n` +
      'It imports packages/feature-flags/src/registry.ts directly and relies on native\n' +
      'TypeScript type stripping, which is enabled by default from 22.18.0.',
  );
  process.exit(1);
}

/** Load the registry. Async because it is a dynamic `import()` of a `.ts` file. */
export async function loadRegistry() {
  return import(pathToFileURL(registryPath).href);
}

const TS_BANNER = `// GENERATED — do not edit.
// Source: packages/feature-flags/src/registry.ts
// Regenerate: node scripts/codegen/gen-feature-flags.mjs
//
// Edit the registry, not this file. \`--check\` fails CI when the two disagree.
`;

/**
 * `object` maps to the same recursive `JsonValue` shape `schema.ts` validates
 * variant values against (re-declared here, not imported — this generated
 * file is a standalone, zero-import TYPES module by design, same as the
 * `FlagKey`/`FlagValueMap` it sits next to).
 */
const TS_TYPE_FOR = { boolean: 'boolean', string: 'string', number: 'number', object: 'JsonValue' };

const JSON_VALUE_TS = `/** A JSON value — mirrors \`schema.ts\`'s \`JsonValue\`, re-declared here to keep this file import-free. */
export type JsonValue = boolean | string | number | null | JsonValue[] | { [key: string]: JsonValue };`;

/**
 * The TS client's typed surface: a `FlagKey` union and a `FlagValue<K>`
 * mapped type, plus a plain `FLAG_KEYS` array for runtime iteration
 * (`for (const key of FLAG_KEYS)` — e.g. a debug page listing every flag).
 */
export function renderFlagsTs(registry) {
  const { FLAG_REGISTRY } = registry;
  const keys = FLAG_REGISTRY.map((f) => f.key);
  const usesObjectType = FLAG_REGISTRY.some((f) => f.type === 'object');

  const keyUnion = keys.map((k) => `  | '${k}'`).join('\n');
  const valueMapEntries = FLAG_REGISTRY.map((f) => `  '${f.key}': ${TS_TYPE_FOR[f.type]};`).join(
    '\n',
  );
  const keysArray = JSON.stringify(keys, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');

  return `${TS_BANNER}
${usesObjectType ? JSON_VALUE_TS + '\n\n' : ''}/** Every declared flag key. */
export type FlagKey =
${keyUnion};

/** Flag key -> its evaluated value type. */
export interface FlagValueMap {
${valueMapEntries}
}

/** The value type \`evaluateFlag(key, ...)\` resolves to for a given key. */
export type FlagValue<K extends FlagKey> = FlagValueMap[K];

/** Every declared flag key, in registry order — for runtime iteration. */
export const FLAG_KEYS: readonly FlagKey[] = ${keysArray};
`;
}

/**
 * The language-neutral manifest. Every field a non-TS generator would need:
 * key, description, type, variants + their values, default variant, the
 * experiment split (if any), owner, tags. No TS syntax, no zod — plain JSON.
 */
export function renderManifestJson(registry) {
  const { FLAG_REGISTRY } = registry;
  const manifest = {
    $schema: 'https://lorekit.dev/schemas/feature-flags-manifest-v1.json',
    generatedFrom: 'packages/feature-flags/src/registry.ts',
    flags: FLAG_REGISTRY.map((f) => ({
      key: f.key,
      description: f.description,
      type: f.type,
      variants: f.variants,
      defaultVariant: f.defaultVariant,
      experiment: f.experiment ?? null,
      owner: f.owner,
      tags: f.tags,
    })),
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/** Every artifact this generator owns. Exported so a spec can assert the set. */
export const GENERATED_TARGETS = [
  {
    path: 'packages/feature-flags/src/generated/flags.generated.ts',
    render: renderFlagsTs,
  },
  {
    path: 'packages/feature-flags/generated/flags.manifest.json',
    render: renderManifestJson,
  },
];

async function main() {
  assertNodeSupportsTypeStripping();
  const check = process.argv.includes('--check');
  const registry = await loadRegistry();
  const stale = [];

  for (const target of GENERATED_TARGETS) {
    const to = join(repoRoot, target.path);
    const expected = target.render(registry);

    if (check) {
      if (!existsSync(to) || readFileSync(to, 'utf8') !== expected) stale.push(target.path);
      continue;
    }

    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, expected);
  }

  if (check && stale.length) {
    console.error(
      `Generated feature-flag artifacts are stale:\n  ${stale.join('\n  ')}\n` +
        'Run: node scripts/codegen/gen-feature-flags.mjs',
    );
    process.exit(1);
  }
  console.log(
    check
      ? `Feature-flag artifacts are in sync (${GENERATED_TARGETS.length} files).`
      : `Generated ${GENERATED_TARGETS.length} feature-flag artifact(s).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
