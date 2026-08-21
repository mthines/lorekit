import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Freshness and portability guard for `scripts/gen-surfaces.mjs`.
 *
 * The generator emits the surface artifacts that cannot simply import the tool
 * catalog. A committed generated file has one failure mode — it silently goes
 * stale — so `--check` is the load-bearing assertion, and it lives in a SPEC
 * rather than a workflow step on purpose: `scripts/**` is outside the paths
 * `nx affected` considers (ci.yml says so explicitly), so a workflow-step-only
 * gate would be skipped precisely on a change to the generator itself. A spec
 * inside `mcp-core` runs whenever `mcp-core` is affected, and the generated
 * artifacts live inside affected packages.
 *
 * Two of these tests are deliberately SELF-VERIFYING: they perturb the real
 * artifact and assert the gate goes red. A freshness gate that has never been
 * observed to fail is indistinguishable from one that cannot fail — which is
 * exactly how the first draft of this gate shipped as a `grep -E` with a
 * negative lookahead that ERE does not support, so `! grep …` reported success
 * on every possible input.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const generator = 'scripts/gen-surfaces.mjs';
const cliArtifact = 'packages/cli/src/surfaces.generated.mjs';

function runGenerator(args: string[], cwd = repoRoot): string {
  return execFileSync('node', [generator, ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
}

describe('gen-surfaces freshness', () => {
  it('reports the committed artifacts as in sync', () => {
    expect(() => runGenerator(['--check'])).not.toThrow();
  });

  it('is idempotent — a regenerate leaves the committed artifact byte-identical', () => {
    const before = readFileSync(path.join(repoRoot, cliArtifact), 'utf8');
    runGenerator([]);
    expect(readFileSync(path.join(repoRoot, cliArtifact), 'utf8')).toBe(before);
  });

  // The gate-bites proof, permanent rather than a one-off manual step: a
  // perturbation of the REAL artifact must turn --check red. Restored in
  // `finally` so a failure here cannot leave the tree dirty.
  it('goes RED when the committed artifact is edited by hand', () => {
    const artifact = path.join(repoRoot, cliArtifact);
    const original = readFileSync(artifact, 'utf8');
    try {
      writeFileSync(artifact, original.replace('memory.write', 'memory.wrote'));
      expect(() => runGenerator(['--check'])).toThrow();
    } finally {
      writeFileSync(artifact, original);
    }
    // And green again once restored — so the red above was caused by the
    // perturbation, not by an unrelated broken invocation.
    expect(() => runGenerator(['--check'])).not.toThrow();
  });
});

describe('gen-surfaces portability', () => {
  /**
   * The generator's contract says it runs on a bare checkout with no
   * `node_modules`. Asserted BEHAVIOURALLY — by running it in a temp tree that
   * has no `node_modules` anywhere in its ancestor chain — rather than by
   * grepping the source for bare specifiers. A grep states the symptom; this
   * states the requirement, and it cannot pass vacuously.
   */
  it('runs with no node_modules reachable and produces identical output', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'gen-surfaces-'));
    try {
      // Reproduce only the layout the generator resolves against.
      mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
      mkdirSync(path.join(sandbox, 'packages/schemas/src'), { recursive: true });
      copyFileSync(path.join(repoRoot, generator), path.join(sandbox, generator));
      copyFileSync(
        path.join(repoRoot, 'packages/schemas/src/tool-catalog.ts'),
        path.join(sandbox, 'packages/schemas/src/tool-catalog.ts'),
      );

      expect(() => runGenerator([], sandbox)).not.toThrow();

      // Byte-identical to the committed artifact: the generator depends on
      // nothing outside the catalog, so a bare tree must yield the same bytes.
      expect(readFileSync(path.join(sandbox, cliArtifact), 'utf8')).toBe(
        readFileSync(path.join(repoRoot, cliArtifact), 'utf8'),
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('imports nothing but node: builtins and the catalog', () => {
    const source = readFileSync(path.join(repoRoot, generator), 'utf8');
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);

    // Anti-vacuity: if the match found nothing, the assertion below is empty.
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:'), `unexpected dependency: ${specifier}`).toBe(true);
    }
  });
});

describe('the published CLI artifact stays publishable', () => {
  const artifact = () => readFileSync(path.join(repoRoot, cliArtifact), 'utf8');

  it('carries the GENERATED banner naming its source and regenerate command', () => {
    expect(artifact()).toContain('GENERATED — do not edit.');
    expect(artifact()).toContain('packages/schemas/src/tool-catalog.ts');
    expect(artifact()).toContain('node scripts/gen-surfaces.mjs');
  });

  /**
   * `@lorekit/cli` has NO dependencies and declares `engines.node >= 18`, so
   * the artifact must be plain data: an import would break the published
   * package, and anything needing type stripping would break the engine floor.
   */
  it('is pure data — no imports, no require', () => {
    expect(artifact()).not.toMatch(/^\s*import\s/m);
    expect(artifact()).not.toMatch(/require\s*\(/);
  });
});
