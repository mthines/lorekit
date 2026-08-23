import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  MCP_SERVER_NAME,
  READ_TOOLS,
  WRITE_TOOLS,
  buildMcpConfig,
  writeMcpConfig,
} from "../../src/harness/mcp-config.mjs";
import { LOREKIT_BIN } from "../../src/sandbox/paths.mjs";
import { withSandbox } from "../../src/sandbox/sandbox.mjs";

test("the MCP server runs the local CLI against the scratch store (AC-2.1)", () => {
  const config = buildMcpConfig({
    lorekitHome: "/tmp/s/home",
    lorekitStore: "/tmp/s/store",
    bin: "/repo/packages/cli/bin/lorekit.mjs",
  });
  const server = config.mcpServers[MCP_SERVER_NAME];

  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, ["/repo/packages/cli/bin/lorekit.mjs", "mcp"]);
  // Local stdio, never `npx -y mcp-remote <url>` — an eval must not reach the
  // hosted store.
  assert.equal(JSON.stringify(server).includes("mcp-remote"), false);
  assert.equal(server.env.LOREKIT_HOME, "/tmp/s/home");
  assert.equal(server.env.LOREKIT_STORE, "/tmp/s/store");
  assert.equal(server.env.LOREKIT_MODE, "local");
  assert.equal(server.env.LOREKIT_TELEMETRY, "0");
});

test("buildMcpConfig refuses to build an unscoped server", () => {
  assert.throws(() => buildMcpConfig({}), TypeError);
  assert.throws(() => buildMcpConfig({ lorekitHome: "/tmp/h" }), TypeError);
});

test("the tool allow-list is read-only unless a write arm opts in (AC-2.1)", async () => {
  await withSandbox({}, async (sandbox) => {
    const readOnly = await writeMcpConfig(sandbox);
    assert.deepEqual(readOnly.allowedTools, READ_TOOLS);
    assert.equal(readOnly.allowedTools.includes(WRITE_TOOLS[0]), false);

    const writable = await writeMcpConfig(sandbox, { allowWrite: true });
    assert.deepEqual(writable.allowedTools, [...READ_TOOLS, ...WRITE_TOOLS]);
  });
});

test("tool names use Claude Code's namespaced underscore form", () => {
  // `memory.search` is advertised by the server; Claude Code exposes it as
  // `mcp__<server>__memory_search` (see packages/cli/src/adapters/claude.mjs).
  assert.deepEqual(READ_TOOLS, [
    "mcp__lorekit__memory_read",
    "mcp__lorekit__memory_list",
    "mcp__lorekit__memory_search",
  ]);
  assert.deepEqual(WRITE_TOOLS, ["mcp__lorekit__memory_write"]);
});

test("the config is written outside the agent's working directory (AC-2.4)", async () => {
  await withSandbox({}, async (sandbox) => {
    const written = await writeMcpConfig(sandbox);
    assert.equal(path.dirname(written.path), sandbox.root);
    assert.equal(written.path.startsWith(sandbox.cwd), false);

    const onDisk = JSON.parse(await fsp.readFile(written.path, "utf8"));
    assert.deepEqual(onDisk, written.config);
    assert.equal(
      onDisk.mcpServers.lorekit.env.LOREKIT_HOME,
      sandbox.lorekitHome,
    );
  });
});

test("the resolved CLI entrypoint is this checkout's", () => {
  assert.match(LOREKIT_BIN, /packages\/cli\/bin\/lorekit\.mjs$/);
});
