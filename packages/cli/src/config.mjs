// Project layout + .mcp.json read/merge helpers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/ — the installable package root (this file lives in src/).
export const PKG_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SKILL_SOURCE = path.join(PKG_ROOT, 'skill', 'lorekit-memory');
export const SKILL_NAME = 'lorekit-memory';

export function resolveProjectRoot(dir) {
  return path.resolve(dir || process.cwd());
}

export function mcpJsonPath(root) {
  return path.join(root, '.mcp.json');
}

export function skillInstallDir(root) {
  return path.join(root, '.claude', 'skills', SKILL_NAME);
}

// Throwing read — used by `install` so a corrupt .mcp.json aborts the write
// instead of silently clobbering the user's file.
export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${e.message}`);
  }
}

// Non-throwing read — used by the diagnostic (doctor) and hook read paths,
// which must degrade gracefully rather than crash on a malformed file.
// Distinguishes absent from present-but-invalid so callers can report it.
export function readMcpConfig(root) {
  const file = mcpJsonPath(root);
  if (!fs.existsSync(file)) return { present: false, valid: false, config: null };
  try {
    return { present: true, valid: true, config: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { present: true, valid: false, config: null };
  }
}

// Merge a lorekit server entry into .mcp.json, preserving any other servers.
export function upsertMcpServer(root, remoteUrl) {
  const file = mcpJsonPath(root);
  const config = readJsonIfExists(file) || {};
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const existed = Boolean(config.mcpServers.lorekit);
  config.mcpServers.lorekit = {
    command: 'npx',
    args: ['-y', 'mcp-remote', remoteUrl],
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return { file, existed };
}

// Pull the configured lorekit remote URL out of .mcp.json, if present.
// Non-throwing: returns null when the file is absent, invalid, or has no
// lorekit server. Callers that need to distinguish those use readMcpConfig.
export function readLorekitServer(root) {
  const { config } = readMcpConfig(root);
  const server = config && config.mcpServers && config.mcpServers.lorekit;
  if (!server) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const url = args.find((a) => typeof a === 'string' && /^https?:\/\//.test(a));
  return { server, url: url || null };
}

// Recursively copy the skill source into the target, skipping files that
// already exist unless `force` is set. Returns the number of files actually
// written, so the caller can report "installed" / "updated" / "unchanged"
// honestly instead of guessing from whether the directory pre-existed.
export function copyDir(src, dest, { force = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  let written = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      written += copyDir(from, to, { force });
    } else {
      if (fs.existsSync(to) && !force) continue;
      fs.copyFileSync(from, to);
      written++;
    }
  }
  return written;
}

// Resolve endpoint + token from flags, then env, in that order.
export function resolveConnection(args) {
  const endpoint =
    args.endpoint ||
    process.env.LOREKIT_MCP_URL ||
    process.env.LOREKIT_ENDPOINT ||
    null;
  const token = args.token || process.env.LOREKIT_TOKEN || null;
  return {
    endpoint: typeof endpoint === 'string' ? endpoint.trim() : null,
    token: typeof token === 'string' ? token.trim() : null,
  };
}

export function tokenKind(token) {
  if (!token) return 'none';
  if (token.startsWith('lk_rw_')) return 'read-write';
  if (token.startsWith('lk_ro_')) return 'read-only';
  return 'unknown';
}

// For hooks: resolve the connection from the project's .mcp.json first
// (that is where `lorekit install` wrote the token), then fall back to env.
// `splitEndpoint` is passed in to avoid a circular import with mcp.mjs.
export function resolveProjectConnection(root, splitEndpoint) {
  const configured = readLorekitServer(root);
  if (configured && configured.url) {
    const { endpoint, token } = splitEndpoint(configured.url);
    if (endpoint && !endpoint.includes('<project-ref>')) {
      return {
        endpoint,
        token: token || process.env.LOREKIT_TOKEN || null,
      };
    }
  }
  return resolveConnection({});
}
