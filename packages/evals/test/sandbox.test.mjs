import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  INFORMATION_ENVIRONMENT_FILES,
  REAL_LOREKIT_HOME,
  createSandbox,
  isInsideRealHome,
  withSandbox,
} from "../src/sandbox.mjs";

test("scratch LOREKIT_HOME is never the real store (AC-1.1)", async () => {
  const sandbox = await createSandbox();
  try {
    assert.notEqual(
      path.resolve(sandbox.lorekitHome),
      path.resolve(REAL_LOREKIT_HOME),
    );
    assert.equal(isInsideRealHome(sandbox.lorekitHome), false);
    assert.equal(isInsideRealHome(sandbox.lorekitStore), false);
    assert.equal(isInsideRealHome(sandbox.cwd), false);
    assert.ok(sandbox.root.startsWith(path.resolve(os.tmpdir())));
  } finally {
    await sandbox.dispose();
  }
});

test("isInsideRealHome does not treat a sibling prefix as a child", () => {
  const home = "/home/u/.lorekit";
  assert.equal(isInsideRealHome("/home/u/.lorekit", home), true);
  assert.equal(isInsideRealHome("/home/u/.lorekit/store", home), true);
  assert.equal(isInsideRealHome("/home/u/.lorekit-eval", home), false);
  assert.equal(isInsideRealHome("/tmp/lorekit-eval-x", home), false);
});

test("sandbox env forces the offline store and opts out of telemetry (AC-1.1)", async () => {
  await withSandbox({}, async (sandbox) => {
    assert.equal(sandbox.env.LOREKIT_MODE, "local");
    assert.equal(sandbox.env.LOREKIT_HOME, sandbox.lorekitHome);
    assert.equal(sandbox.env.LOREKIT_STORE, sandbox.lorekitStore);
    assert.equal(sandbox.env.LOREKIT_TELEMETRY, "0");
    assert.equal(sandbox.env.DO_NOT_TRACK, "1");

    const childEnv = sandbox.childEnv({ EXTRA: "1" });
    assert.equal(childEnv.LOREKIT_HOME, sandbox.lorekitHome);
    assert.equal(childEnv.EXTRA, "1");
    assert.equal(childEnv.PATH, process.env.PATH);
  });
});

test("dispose removes the whole tree and is idempotent (AC-1.1)", async () => {
  const sandbox = await createSandbox();
  const { root, cwd, lorekitHome } = sandbox;
  assert.ok(fs.existsSync(cwd));
  assert.ok(fs.existsSync(lorekitHome));

  await sandbox.dispose();
  assert.equal(sandbox.disposed(), true);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(cwd), false);
  assert.equal(fs.existsSync(lorekitHome), false);

  await sandbox.dispose(); // must not throw
});

test("withSandbox tears down even when the body throws", async () => {
  let captured;
  await assert.rejects(
    withSandbox({}, async (sandbox) => {
      captured = sandbox.root;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(fs.existsSync(captured), false);
});

test("keep:true leaves the tree for inspection", async () => {
  const sandbox = await createSandbox({ keep: true });
  await sandbox.dispose();
  assert.equal(fs.existsSync(sandbox.root), true);
  await fsp.rm(sandbox.root, { recursive: true, force: true });
});

test("stripInformationEnvironment clears agent-instruction files (seam for AC-2.4)", async () => {
  await withSandbox({}, async (sandbox) => {
    await fsp.writeFile(
      path.join(sandbox.cwd, "CLAUDE.md"),
      "scopes use :: as separator",
    );
    await fsp.mkdir(path.join(sandbox.cwd, ".github"), { recursive: true });
    await fsp.writeFile(
      path.join(sandbox.cwd, ".github", "copilot-instructions.md"),
      "scopes use :: as separator",
    );
    await fsp.writeFile(path.join(sandbox.cwd, "keep-me.txt"), "unrelated");

    const removed = await sandbox.stripInformationEnvironment();
    assert.ok(removed.includes("CLAUDE.md"));
    assert.ok(
      removed.includes(path.join(".github", "copilot-instructions.md")),
    );

    for (const rel of INFORMATION_ENVIRONMENT_FILES) {
      assert.equal(fs.existsSync(path.join(sandbox.cwd, rel)), false, rel);
    }
    assert.equal(fs.existsSync(path.join(sandbox.cwd, "keep-me.txt")), true);
  });
});

test("stripInformationEnvironment throws rather than reporting an undeletable file as absent", async () => {
  await withSandbox({}, async (sandbox) => {
    // `.github` is a FILE here, so removing `.github/copilot-instructions.md`
    // fails with ENOTDIR, not ENOENT. Before the fix that was swallowed and the
    // caller was told the cwd was clean; the isolation invariant PR2 asserts on
    // must not be satisfiable by a delete that did not happen.
    await fsp.writeFile(path.join(sandbox.cwd, ".github"), "not a directory");
    await assert.rejects(
      () => sandbox.stripInformationEnvironment(),
      (err) => err.code === "ENOTDIR",
    );
  });
});

test("two sandboxes never share a directory (fresh context per rep)", async () => {
  const a = await createSandbox();
  const b = await createSandbox();
  try {
    assert.notEqual(a.root, b.root);
    assert.notEqual(a.lorekitHome, b.lorekitHome);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});
