// Can a live run start here? The gate that makes the harness safe in CI.
//
// Every assertion injects its own resolver and environment, so nothing here
// depends on whether the machine running the suite happens to have `claude`
// installed or a key exported — which is the same property the gate itself is
// supposed to give the workflow.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CREDENTIAL_ENV_VARS,
  REASON_BYPASS_AS_ROOT,
  REASON_NO_BINARY,
  REASON_NO_CREDENTIAL,
  assessRunnability,
  describeRunnability,
  resolveCommandPath,
} from "../../src/harness/runnable.mjs";

const found = () => "/usr/local/bin/claude";
const notFound = () => null;
const kinds = (a) => a.reasons.map((r) => r.kind);

test("a runner with a binary and a key can run", () => {
  const a = assessRunnability({
    env: { ANTHROPIC_API_KEY: "sk-test" },
    resolve: found,
    uid: 1001,
  });
  assert.equal(a.runnable, true);
  assert.deepEqual(a.reasons, []);
  assert.equal(a.credential, "ANTHROPIC_API_KEY");
  assert.match(
    describeRunnability(a),
    /available \(credential: ANTHROPIC_API_KEY\)/,
  );
});

test("either credential variable is sufficient", () => {
  // Reporting an OAuth-authenticated runner as having "no credential" would
  // send someone to add a secret they do not need.
  for (const name of CREDENTIAL_ENV_VARS) {
    const a = assessRunnability({
      env: { [name]: "value" },
      resolve: found,
      uid: 1001,
    });
    assert.equal(a.runnable, true, name);
    assert.equal(a.credential, name);
  }
});

test("an empty or whitespace credential is no credential", () => {
  // The exact shape a fork PR produces: the secret interpolates to "".
  for (const value of ["", "   "]) {
    const a = assessRunnability({
      env: { ANTHROPIC_API_KEY: value },
      resolve: found,
      uid: 1001,
    });
    assert.equal(a.runnable, false);
    assert.deepEqual(kinds(a), [REASON_NO_CREDENTIAL]);
  }
});

test("every missing precondition is reported, not just the first", () => {
  // Otherwise adding the secret only reveals the next problem, and learning one
  // thing costs two CI round trips.
  const a = assessRunnability({ env: {}, resolve: notFound, uid: 0 });
  assert.equal(a.runnable, false);
  assert.deepEqual(kinds(a), [
    REASON_NO_BINARY,
    REASON_NO_CREDENTIAL,
    REASON_BYPASS_AS_ROOT,
  ]);
  const text = describeRunnability(a);
  for (const fragment of ["not on PATH", "ANTHROPIC_API_KEY", "as root"]) {
    assert.ok(text.includes(fragment), `missing "${fragment}" in: ${text}`);
  }
});

test("bypassPermissions under root is caught BEFORE anything spawns", () => {
  // The expensive-to-diagnose one: the CLI refuses it and the visible symptom
  // is a 0-byte transcript, which every downstream classifier misreads.
  const asRoot = { env: { ANTHROPIC_API_KEY: "k" }, resolve: found, uid: 0 };
  assert.deepEqual(
    kinds(
      assessRunnability({ ...asRoot, permissionMode: "bypassPermissions" }),
    ),
    [REASON_BYPASS_AS_ROOT],
  );
  // The documented workaround must actually clear it…
  assert.equal(
    assessRunnability({ ...asRoot, permissionMode: "acceptEdits" }).runnable,
    true,
  );
  // …and so must not being root, which is the GitHub Actions case.
  assert.equal(
    assessRunnability({
      ...asRoot,
      uid: 1001,
      permissionMode: "bypassPermissions",
    }).runnable,
    true,
  );
});

test("an unknown uid never invents the root failure", () => {
  // `process.getuid` is absent on Windows. Reporting a refusal that platform
  // cannot have would be a fabricated blocker.
  assert.equal(
    assessRunnability({
      env: { ANTHROPIC_API_KEY: "k" },
      resolve: found,
      uid: null,
    }).runnable,
    true,
  );
});

test("resolveCommandPath finds an executable the way a shell would", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "evals-path-"));
  try {
    const bin = path.join(dir, "claude");
    await fsp.writeFile(bin, "#!/bin/sh\n");
    await fsp.chmod(bin, 0o755);

    // A bare name is looked up across PATH…
    assert.equal(resolveCommandPath("claude", { env: { PATH: dir } }), bin);
    assert.equal(resolveCommandPath("claude", { env: { PATH: "" } }), null);
    // …an explicit path is checked as given, PATH irrelevant.
    assert.equal(resolveCommandPath(bin, { env: { PATH: "" } }), bin);

    // A non-executable file of the right name is NOT the binary.
    const dud = path.join(dir, "nope");
    await fsp.writeFile(dud, "");
    await fsp.chmod(dud, 0o644);
    assert.equal(resolveCommandPath("nope", { env: { PATH: dir } }), null);
    // Neither is a directory that happens to be named right.
    fs.mkdirSync(path.join(dir, "dirbin"));
    assert.equal(resolveCommandPath("dirbin", { env: { PATH: dir } }), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("resolveCommandPath is total on junk input", () => {
  for (const value of ["", null, undefined]) {
    assert.equal(
      resolveCommandPath(value, { env: { PATH: "/usr/bin" } }),
      null,
    );
  }
  // A PATH that is absent entirely, not merely empty.
  assert.equal(resolveCommandPath("claude", { env: {} }), null);
});
