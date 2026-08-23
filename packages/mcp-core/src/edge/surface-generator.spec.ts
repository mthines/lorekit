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
 * Several of these tests are deliberately SELF-VERIFYING: they generate into a
 * throwaway tree, perturb the artifact there, and assert the gate goes red. A
 * freshness gate that has never been observed to fail is indistinguishable from
 * one that cannot fail — which is exactly how the first draft of this gate
 * shipped as a `grep -E` with a negative lookahead that ERE does not support,
 * so `! grep …` reported success on every possible input.
 *
 * The perturbation happens in a sandbox rather than on the committed file (see
 * `sandbox()`): restoring in a `finally` narrows the window but does not close
 * it, since an interrupted run never reaches the `finally` at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const generator = 'scripts/gen-surfaces.mjs';
const cliArtifact = 'packages/cli/src/surfaces.generated.mjs';
const edgeArtifact = 'supabase/functions/mcp/tool-dispatch.generated.ts';

/**
 * Both artifacts the generator owns. The freshness cases run over BOTH, because
 * they used to run over the CLI one only — so when the edge dispatch map was
 * added as a second target, nothing proved it went red on a hand-edit. A gate
 * that covers one of two outputs reports a guarantee it is half providing, and
 * the uncovered half was the one whose staleness a reviewer cannot spot by eye
 * (a dispatch map binding an op to the wrong handler still looks plausible).
 *
 * A literal list, cross-checked against the generator's own `GENERATED_TARGETS`
 * in its own case below, so adding a third target fails until it is listed here
 * too. The cross-check reads the manifest out of the SOURCE rather than
 * importing it: `@nx/enforce-module-boundaries` (correctly) forbids reaching
 * into `scripts/` by relative path from inside a project, and this file already
 * reads that source for the bare-specifier scan.
 */
const ARTIFACTS = [cliArtifact, edgeArtifact];

/** The `path:` values of the generator's `GENERATED_TARGETS`, read from source. */
function declaredTargets(): string[] {
  const source = readFileSync(path.join(repoRoot, generator), 'utf8');
  const manifest = source.slice(source.indexOf('export const GENERATED_TARGETS'));
  return [...manifest.matchAll(/\{\s*path:\s*'([^']+)'/g)].map((m) => m[1] as string);
}

function runGenerator(args: string[], cwd = repoRoot): string {
  return execFileSync('node', [generator, ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
}

/**
 * A throwaway tree containing only what the generator resolves against, so a
 * test can perturb an artifact without touching the worktree.
 *
 * The perturbation tests used to edit the REAL committed artifact and restore
 * it in a `finally`. That is fine until the run is interrupted — Ctrl-C or a
 * timeout kills the process before `finally` runs and leaves a corrupted file
 * staged for whoever commits next. A sandbox removes the failure mode instead
 * of narrowing it, and costs nothing: the generator resolves every path from
 * its own location, so a copy of it plus the catalog behaves identically.
 */
function sandbox(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'gen-surfaces-'));
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'packages/schemas/src/shared'), { recursive: true });
  copyFileSync(path.join(repoRoot, generator), path.join(dir, generator));
  copyFileSync(
    path.join(repoRoot, 'packages/schemas/src/shared/tool-catalog.ts'),
    path.join(dir, 'packages/schemas/src/shared/tool-catalog.ts'),
  );
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('gen-surfaces freshness', () => {
  it('reports the committed artifacts as in sync', () => {
    expect(() => runGenerator(['--check'])).not.toThrow();
  });

  it('owns exactly the artifacts these tests cover', () => {
    // Guards the list above against the generator growing a third target that
    // the freshness cases then silently skip — which is the bug this file just
    // had, one target late.
    const declared = declaredTargets();
    // Anti-vacuity: a manifest the regex failed to parse would make the
    // comparison below trivially true on two empty arrays.
    expect(declared.length).toBe(ARTIFACTS.length);
    expect([...declared].sort()).toEqual([...ARTIFACTS].sort());
  });

  it.each(ARTIFACTS)('is idempotent — regenerating in a sandbox reproduces %s byte for byte', (artifact) => {
    // Byte-for-byte equality with the committed artifact IS the idempotence
    // claim, and asserting it against a fresh generate in a sandbox proves it
    // without rewriting the file under test.
    const { dir, dispose } = sandbox();
    try {
      runGenerator([], dir);
      expect(readFileSync(path.join(dir, artifact), 'utf8')).toBe(
        readFileSync(path.join(repoRoot, artifact), 'utf8'),
      );
    } finally {
      dispose();
    }
  });

  // The gate-bites proof, permanent rather than a one-off manual step. Run in a
  // sandbox so an interrupted test can never leave the real artifact perturbed.
  it.each(ARTIFACTS)('goes RED when %s is edited by hand', (artifact) => {
    const { dir, dispose } = sandbox();
    try {
      runGenerator([], dir);
      const target = path.join(dir, artifact);
      // Green first, so the red below is attributable to the perturbation and
      // not to something already wrong with the sandbox.
      expect(() => runGenerator(['--check'], dir)).not.toThrow();

      // `memory.write` appears in both artifacts — as a name in the CLI's data
      // module, and as a dispatch key in the edge map — so one perturbation
      // works for both. Asserted rather than assumed: a silent no-op edit would
      // leave `--check` green and the test would pass for the wrong reason.
      const before = readFileSync(target, 'utf8');
      expect(before, `${artifact} does not contain the perturbation target`).toContain('memory.write');
      writeFileSync(target, before.replace('memory.write', 'memory.wrote'));
      expect(() => runGenerator(['--check'], dir)).toThrow();

      runGenerator([], dir);
      expect(() => runGenerator(['--check'], dir)).not.toThrow();
    } finally {
      dispose();
    }
  });

  it.each(ARTIFACTS)('goes RED when %s is missing entirely', (artifact) => {
    const { dir, dispose } = sandbox();
    try {
      runGenerator([], dir);
      rmSync(path.join(dir, artifact));
      expect(() => runGenerator(['--check'], dir)).toThrow();
    } finally {
      dispose();
    }
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
    // `sandbox()` builds exactly the bare tree this test needs: the generator
    // and the catalog, and nothing else — no node_modules anywhere in the
    // ancestor chain, since it lives under the OS temp dir.
    const { dir, dispose } = sandbox();
    try {
      expect(() => runGenerator([], dir)).not.toThrow();

      // Byte-identical to the committed artifact: the generator depends on
      // nothing outside the catalog, so a bare tree must yield the same bytes.
      expect(readFileSync(path.join(dir, cliArtifact), 'utf8')).toBe(
        readFileSync(path.join(repoRoot, cliArtifact), 'utf8'),
      );
    } finally {
      dispose();
    }
  });

  it('imports nothing but node: builtins', () => {
    // Template literals are stripped FIRST. The generator emits source, and
    // that emitted source contains `from './tools.ts'` — scanning the raw file
    // matched the imports it WRITES as though they were imports it HAS, which
    // is a false positive that appeared the moment a second target was added.
    const source = readFileSync(path.join(repoRoot, generator), 'utf8').replace(/`[\s\S]*?`/g, '``');
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
    expect(artifact()).toContain('packages/schemas/src/shared/tool-catalog.ts');
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
