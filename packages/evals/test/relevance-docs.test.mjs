import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── AC-7 (sweep): README documents the scale/position sweep (PR5) ────────────

test("AC-7-sweep: README Status line names PR5 as shipped", () => {
  const readme = read("README.md");
  // PR5 must appear in the Status section.
  assert.match(readme, /PR5/);
  // The status must reflect PR5 is shipped (not "still to come").
  // We assert the sweep section exists — if it's "still to come" this line won't match.
  assert.match(readme, /scale\/position sweep/i);
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
  // one test that imports it (mine-ground-truth.test.mjs) only exercises the
  // pure exports + the refusal paths (main([]) / unusable connection), never a
  // real query — asserted by that suite. Here we guard that no OTHER test file
  // IMPORTS it (matched on an actual import specifier, not a mere mention — this
  // file names the script in its own assertions and must not match itself), and
  // that the bin is not auto-run by a test glob.
  const testDir = path.join(ROOT, "test");
  const IMPORT_SPECIFIER = /from\s+["'][^"']*bin\/mine-ground-truth\.mjs["']/;
  const importers = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .filter((f) => IMPORT_SPECIFIER.test(read(path.join("test", f))));
  assert.deepEqual(
    importers,
    ["mine-ground-truth.test.mjs"],
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
