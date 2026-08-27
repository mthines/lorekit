/**
 * Freshness guard for `scripts/codegen/gen-feature-flags.mjs`'s two committed
 * artifacts. Runs the generator as a SUBPROCESS rather than importing it:
 * `@nx/enforce-module-boundaries` (correctly) forbids reaching into
 * `scripts/` by relative path from inside a project — see
 * `packages/mcp-core/src/edge/surface-generator.spec.ts` for the same
 * pattern against `gen-surfaces.mjs`.
 *
 * Lives in a spec (not only a CI workflow step) because `scripts/**` is
 * outside the paths `nx affected` considers, so a workflow-step-only gate
 * would be skipped precisely on a change to the generator itself. A spec
 * inside `feature-flags` runs whenever `feature-flags` is affected, and the
 * generated artifacts live inside that same affected package.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const generator = 'scripts/codegen/gen-feature-flags.mjs';
const registry = 'packages/feature-flags/src/registry.ts';
const schema = 'packages/feature-flags/src/schema.ts';
const tsArtifact = 'packages/feature-flags/src/generated/flags.generated.ts';
const jsonArtifact = 'packages/feature-flags/generated/flags.manifest.json';

function runGenerator(args: string[], cwd = repoRoot): string {
  return execFileSync('node', ['--experimental-transform-types', generator, ...args], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

/**
 * A throwaway tree containing only what the generator resolves against.
 *
 * Nested inside `.agent/` (already git-ignored — see `.agent/.gitignore`)
 * rather than `os.tmpdir()` — `registry.ts` imports `zod`, a bare specifier
 * Node's ESM resolver only finds by walking UP from the importing file
 * looking for a `node_modules` directory. A sandbox under `/tmp` has no
 * relation to this repo's `node_modules` and the import fails; a sandbox
 * under the repo root (but NOT inside `node_modules` itself — Node refuses to
 * type-strip any `.ts` file whose path contains a `node_modules` segment)
 * lets the walk reach the real one.
 */
function sandbox(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(repoRoot, '.agent/gen-feature-flags-sandbox-'));
  mkdirSync(path.join(dir, 'scripts/codegen'), { recursive: true });
  mkdirSync(path.join(dir, 'packages/feature-flags/src'), { recursive: true });
  copyFileSync(path.join(repoRoot, generator), path.join(dir, generator));
  copyFileSync(path.join(repoRoot, registry), path.join(dir, registry));
  copyFileSync(path.join(repoRoot, schema), path.join(dir, schema));
  // pnpm's isolated `node_modules` does not hoist `zod` to the repo root, so
  // walking up from the sandboxed `schema.ts` would still fail to resolve it —
  // symlink the real package's `node_modules` (which already has it) in.
  symlinkSync(
    path.join(repoRoot, 'packages/feature-flags/node_modules'),
    path.join(dir, 'packages/feature-flags/node_modules'),
  );
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('gen-feature-flags freshness', () => {
  it('reports the committed artifacts as in sync', () => {
    expect(() => runGenerator(['--check'])).not.toThrow();
  });

  it.each([tsArtifact, jsonArtifact])(
    'is idempotent — regenerating in a sandbox reproduces %s byte for byte',
    (artifact) => {
      const { dir, dispose } = sandbox();
      try {
        runGenerator([], dir);
        expect(readFileSync(path.join(dir, artifact), 'utf8')).toBe(
          readFileSync(path.join(repoRoot, artifact), 'utf8'),
        );
      } finally {
        dispose();
      }
    },
  );
});
