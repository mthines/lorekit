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

export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${e.message}`);
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
export function readLorekitServer(root) {
  const config = readJsonIfExists(mcpJsonPath(root));
  const server = config && config.mcpServers && config.mcpServers.lorekit;
  if (!server) return null;
  const args = Array.isArray(server.args) ? server.args : [];
  const url = args.find((a) => typeof a === 'string' && /^https?:\/\//.test(a));
  return { server, url: url || null };
}

// Recursively copy the skill source into the target, skipping when present
// unless `force` is set.
export function copyDir(src, dest, { force = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to, { force });
    } else {
      if (fs.existsSync(to) && !force) continue;
      fs.copyFileSync(from, to);
    }
  }
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
