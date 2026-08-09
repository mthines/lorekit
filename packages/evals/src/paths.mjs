// Where the harness finds the real LoreKit CLI.
//
// Resolved through the module resolver rather than a `../../cli` relative path
// so the harness follows the workspace link the same way any consumer would,
// and a package move breaks here loudly instead of producing a path that
// silently does not exist.
import { fileURLToPath } from "node:url";

/** Absolute path to the `lorekit` CLI entrypoint the sandbox spawns. */
export const LOREKIT_BIN = fileURLToPath(
  import.meta.resolve("@lorekit/cli/bin/lorekit.mjs"),
);

/**
 * The argv that runs the CLI. `process.execPath` rather than a bare `lorekit`
 * so a run can never pick up a globally-installed CLI of a different version —
 * the whole experiment depends on the store, hook and MCP server being THIS
 * checkout's.
 */
export function lorekitCommand(args = [], { bin = LOREKIT_BIN } = {}) {
  return { command: process.execPath, args: [bin, ...args] };
}
