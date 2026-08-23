import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── AC-7 (sweep): README documents the scale/position sweep (PR5) ────────────

test("AC-7-sweep: README Status line names the sweep as shipped, not still-to-come", () => {
  const readme = read("README.md");

  // Isolate the Status section (from "## Status" up to the next "## " heading) so
  // the assertion cannot be satisfied by the "## Scale/position sweep" heading
  // further down the file.
  const statusMatch = readme.match(/^## Status\b([\s\S]*?)(?=^## )/m);
  assert.ok(statusMatch, "README must have a ## Status section");
  const status = statusMatch[1];

  // The Status must list the scale/position sweep in its SHIPPED clause — i.e.
  // before the "Still to come" boundary. If the sweep were still-to-come this
  // fails, which the previous heading-only match could not detect.
  const shipped = status.split(/Still to come/i)[0];
  assert.match(
    shipped,
    /scale\/position sweep\*\*\s*\(PR5\)/i,
    "Status must name the scale/position sweep (PR5) as shipped, before 'Still to come'",
  );
});

test("AC-7-sweep: README documents the sweep, both arms (recency vs rank), and the cliff", () => {
  const readme = read("README.md");
  // The sweep section must mention both arms.
  assert.match(readme, /recency/i);
  assert.match(readme, /rank/i);
  // The cliff must be documented.
  assert.match(readme, /cliff/i);
  // CANDIDATE_LIMIT must be named (it is the structural cause of the cliff).
  assert.match(readme, /CANDIDATE_LIMIT/);
  // The sweep headline section must be present.
  assert.match(readme, /Scale\/position sweep/i);
});

test("AC-7-sweep: README documents synthetic decoys and the mine upgrade path", () => {
  const readme = read("README.md");
  assert.match(readme, /synthetic/i);
  assert.match(readme, /decoy/i);
  assert.match(readme, /mine-ground-truth/);
  assert.match(readme, /placeholder|upgrade|real (volume|corpus)/i);
});

// ── Existing relevance-docs tests ─────────────────────────────────────────────

test("AC-8: README documents the definition, the placeholder seed, and the mine runbook", () => {
  const readme = read("README.md");
  // The loud placeholder caveat.
  assert.match(readme, /BOOTSTRAP PLACEHOLDER/);
  assert.match(readme, /MUST NOT/);
  // The mine runbook and the real snapshot it produces.
  assert.match(readme, /mine-ground-truth/);
  assert.match(readme, /ground-truth\.real\.json/);
  // The ground-truth definition is pinned to the outcome signal.
  assert.match(readme, /precision@k/);
  assert.match(readme, /recall@k/);
  assert.match(readme, /MRR/);
});

test("AC-7-nowire: the mine script is NOT wired into any script/target/test that would run it", () => {
  // If this ever fails, the script that must stay MANUAL has been auto-wired —
  // which would let a CI run (or a `node --test`) hit the hosted network path.
  const pkg = read("package.json");
  const project = read("project.json");
  assert.equal(
    /mine-ground-truth/.test(pkg),
    false,
    "package.json must not reference mine-ground-truth",
  );
  assert.equal(
    /mine-ground-truth/.test(project),
    false,
    "project.json must not reference mine-ground-truth",
  );

  // No test file IMPORTS the bin in a way that executes its network path. The
  // one test that imports it (test/bin/mine-ground-truth.test.mjs) only
  // exercises the pure exports + the refusal paths (main([]) / unusable
  // connection), never a real query — asserted by that suite. Here we guard
  // that no OTHER test file IMPORTS it (matched on an actual import specifier,
  // not a mere mention — this file names the script in its own assertions and
  // must not match itself), and that the bin is not auto-run by a test glob.
  // Tests live in topic subdirectories (test/<group>/*.test.mjs), so the walk
  // recurses rather than reading `test/` flat.
  const testDir = path.join(ROOT, "test");
  const IMPORT_SPECIFIER = /from\s+["'][^"']*bin\/mine-ground-truth\.mjs["']/;
  function findTestFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return findTestFiles(full);
      return entry.name.endsWith(".test.mjs") ? [full] : [];
    });
  }
  const importers = findTestFiles(testDir)
    .filter((f) => IMPORT_SPECIFIER.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(testDir, f));
  assert.deepEqual(
    importers,
    ["bin/mine-ground-truth.test.mjs"],
    "only the dedicated mine test may import the mine script",
  );
});

test("the mine script never calls process.exit and only auto-runs when invoked directly", () => {
  const bin = read("bin/mine-ground-truth.mjs");
  // No process.exit — returns exit codes so it stays testable (the package's
  // run-eval.mjs convention).
  assert.equal(/process\.exit\(/.test(bin), false);
  // The direct-invocation guard is present, so importing it is side-effect free.
  assert.match(bin, /fileURLToPath\(import\.meta\.url\) === path\.resolve\(process\.argv\[1\]\)/);
});
