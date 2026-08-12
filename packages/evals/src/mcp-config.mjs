// The `.mcp.json` that points the agent under test at the sandbox's own memory.
//
// The CLI's own writers (`upsertMcpServer`, `upsertWebMcpServer` in
// `packages/cli/src/config.mjs`) both emit the REMOTE form — `npx -y mcp-remote
// <url>` — which is exactly what an eval must not use: it would talk to the
// hosted store over the network. The local stdio form has no writer in the CLI,
// so the harness builds it here, and pins the shape with a test.
//
// Every field is deliberate:
//   • `command`/`args` run THIS checkout's CLI through `process.execPath`, so a
//     globally-installed `lorekit` of another version can never be the thing
//     under test.
//   • `env` carries the scratch store. The MCP server resolves its store via
//     `loadControl`, which reads these variables — so the server the agent
//     talks to is rooted in the sandbox by the same mechanism production uses.
//   • the server is named `lorekit`, because Claude Code derives its tool names
//     from the server key (`memory.search` → `mcp__lorekit__memory_search`) and
//     the allow-list below has to match.
import fsp from "node:fs/promises";
import path from "node:path";

import { LOREKIT_BIN } from "./paths.mjs";

/** The server key in `mcpServers`, and therefore the tool-name namespace. */
export const MCP_SERVER_NAME = "lorekit";

/**
 * The memory tools an arm may call, in Claude Code's namespaced form (the dot
 * in `memory.search` becomes an underscore — see
 * `packages/cli/src/adapters/claude.mjs`).
 *
 * READ-ONLY BY DEFAULT. An arm that could call `memory_write` mid-run would
 * contaminate its own store between attempts, and the retry would no longer be
 * measuring the lesson it started with. Arm 0 — the attempt whose job is to
 * PRODUCE the organic lesson — is the one case that needs the write tool, so it
 * opts in explicitly.
 */
export const READ_TOOLS = ["memory_read", "memory_list", "memory_search"].map(
  (t) => `mcp__${MCP_SERVER_NAME}__${t}`,
);
export const WRITE_TOOLS = ["memory_write"].map(
  (t) => `mcp__${MCP_SERVER_NAME}__${t}`,
);

/**
 * Build the `.mcp.json` object for a sandbox. Pure — takes the resolved paths,
 * returns the config — so the shape is unit-testable without touching disk.
 */
export function buildMcpConfig({
  lorekitHome,
  lorekitStore,
  bin = LOREKIT_BIN,
} = {}) {
  if (!lorekitHome || !lorekitStore) {
    throw new TypeError(
      "buildMcpConfig: lorekitHome and lorekitStore are required",
    );
  }
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [bin, "mcp"],
        env: {
          LOREKIT_HOME: lorekitHome,
          LOREKIT_STORE: lorekitStore,
          LOREKIT_MODE: "local",
          LOREKIT_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
        },
      },
    },
  };
}

/**
 * Write the sandbox's `.mcp.json` and return its path plus the tools an arm
 * should be allowed to call.
 *
 * The file is written OUTSIDE the agent's working directory (in the sandbox
 * root) and passed with `--mcp-config`, so the agent cannot read the harness's
 * own wiring as if it were project context — that file naming the store would
 * be one more way for the information environment to differ between arms.
 */
export async function writeMcpConfig(sandbox, { allowWrite = false } = {}) {
  const config = buildMcpConfig(sandbox);
  const file = path.join(sandbox.root, "mcp-config.json");
  await fsp.writeFile(file, JSON.stringify(config, null, 2) + "\n");
  return {
    path: file,
    config,
    allowedTools: allowWrite
      ? [...READ_TOOLS, ...WRITE_TOOLS]
      : [...READ_TOOLS],
  };
}
