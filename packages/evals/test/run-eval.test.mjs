import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { main, parseArgs, runId } from "../bin/run-eval.mjs";

test("parseArgs defaults to the N=3 indicator design (AC-1.3)", () => {
  const options = parseArgs(["arm0"]);
  assert.equal(options.subcommand, "arm0");
  assert.equal(options.reps, 3);
  assert.equal(options.out, ".eval-out");
  assert.equal(options.command, "claude");
  assert.equal(options.dryRun, false);
});

test("parseArgs reads every flag", () => {
  const options = parseArgs([
    "arm0",
    "--reps",
    "5",
    "--out",
    "/tmp/o",
    "--timeout",
    "1000",
    "--command",
    "echo",
    "--keep",
    "--dry-run",
  ]);
  assert.equal(options.reps, 5);
  assert.equal(options.out, "/tmp/o");
  assert.equal(options.timeoutMs, 1000);
  assert.equal(options.command, "echo");
  assert.equal(options.keep, true);
  assert.equal(options.dryRun, true);
});

test("parseArgs rejects nonsense rather than running a bad experiment", () => {
  assert.throws(() => parseArgs(["arm0", "--reps", "0"]), /positive integer/);
  assert.throws(
    () => parseArgs(["arm0", "--reps", "many"]),
    /positive integer/,
  );
  assert.throws(
    () => parseArgs(["arm0", "--timeout", "-1"]),
    /positive number/,
  );
  assert.throws(() => parseArgs(["arm0", "--nope"]), /unknown option/);
});

test("runId is filesystem-safe and sortable", () => {
  const id = runId(new Date("2026-08-08T21:06:56.253Z"));
  assert.equal(id, "2026-08-08T21-06-56-253Z");
  assert.equal(/[:.]/.test(id), false);
});

test("an unimplemented subcommand exits non-zero instead of pretending", async () => {
  const code = await main(["golden"]);
  assert.equal(code, 2);
});

test("arm0 --dry-run writes the artifact tree without spawning (AC-1.3)", async () => {
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), "evals-out-"));
  try {
    const code = await main(["arm0", "--reps", "2", "--dry-run", "--out", out]);
    assert.equal(code, 0);

    const [runDir] = await fsp.readdir(out);
    assert.match(runDir, /^arm0-/);

    const summary = JSON.parse(
      await fsp.readFile(path.join(out, runDir, "summary.json"), "utf8"),
    );
    assert.equal(summary.subcommand, "arm0");
    assert.equal(summary.model, "claude-opus-4-8");
    assert.equal(summary.results.length, 2);
    // The low-power caveat travels with the data, not just the README (AC-1.5).
    assert.match(summary.caveat, /INDICATOR/);
    assert.match(summary.caveat, /directional/i);

    for (const rep of [1, 2]) {
      const meta = JSON.parse(
        await fsp.readFile(
          path.join(out, runDir, `rep-${rep}`, "meta.json"),
          "utf8",
        ),
      );
      assert.equal(meta.rep, rep);
      assert.equal(meta.arm, "0");
      assert.equal(meta.store, "empty");
      assert.equal(meta.model, "claude-opus-4-8");
      // The artifact records WHICH task and WHICH target it was graded against,
      // so a result file read later cannot be misattributed to another task.
      assert.equal(meta.task, "branch-scope");
      assert.equal(meta.targetScope, "branch::mthines/gw-tools::feat/x");
      // Each rep got its own sandbox, and none of them survived the run.
      assert.equal(fs.existsSync(meta.lorekitHome), false);
    }

    const homes = summary.results.map((r) => r.lorekitHome);
    assert.notEqual(homes[0], homes[1]);
  } finally {
    await fsp.rm(out, { recursive: true, force: true });
  }
});
