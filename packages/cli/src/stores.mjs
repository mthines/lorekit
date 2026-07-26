// Resolve BOTH memory stores at once — the offline (local two-tier) store and
// the remote (hosted MCP) store — independent of the active control mode. The
// read commands (`list`, and the stacked `search` / `show` / `stats` / `diff`)
// want to show whatever lives in each place side by side, so unlike
// `createStore(control)` (which picks exactly one by mode) this builds both.
//
// Nothing here invents scope or connection logic: it composes the existing
// `localStoreDirs` (two-tier dirs), `resolveProjectConnection` + `splitEndpoint`
// (endpoint/token from .mcp.json → global → env), and the store builders.
// Zero-dependency.
import process from 'node:process';
import { localStoreDirs } from './control.mjs';
import { resolveProjectConnection } from './config.mjs';
import { splitEndpoint } from './mcp.mjs';
import { createTwoTierStore, createRemoteStore } from './store/index.mjs';

// Build both stores for `root`. Explicit `endpoint` / `token` (e.g. from
// `--endpoint` / `--token` flags) take precedence over the resolved connection;
// `env` feeds the local-tier directory resolution ($LOREKIT_HOME / $LOREKIT_STORE).
// Returns { local, remote, connection } — `connection` is the resolved
// endpoint/token so callers can explain why remote is unusable.
export function resolveStores(root, { env = process.env, endpoint = null, token = null } = {}) {
  const dirs = localStoreDirs(root, env);
  const local = createTwoTierStore(dirs);

  const conn = resolveProjectConnection(root, splitEndpoint);
  const resolvedEndpoint = endpoint || conn.endpoint || null;
  const resolvedToken = token || conn.token || null;
  const remote = createRemoteStore({ endpoint: resolvedEndpoint, token: resolvedToken });

  return {
    local,
    remote,
    connection: { endpoint: resolvedEndpoint, token: resolvedToken },
  };
}

// A bounded, actionable reason a remote listing is unavailable — mirrors the
// checks in `RemoteStore.usable()` so the note tells the user what to fix.
export function remoteUnavailableReason({ endpoint, token } = {}) {
  if (!endpoint) return 'no endpoint configured — run `lorekit install` or set LOREKIT_MCP_URL';
  if (String(endpoint).includes('<project-ref>')) return `endpoint is still a placeholder (${endpoint})`;
  if (!token) return 'no token configured — set LOREKIT_TOKEN or run `lorekit install`';
  return 'not configured';
}
