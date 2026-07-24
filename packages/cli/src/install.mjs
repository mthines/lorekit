// `lorekit install` — scaffold the skill and wire the MCP server.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import {
  SKILL_SOURCE,
  SKILL_NAME,
  resolveProjectRoot,
  skillInstallDir,
  copyDir,
  upsertMcpServer,
  resolveConnection,
  tokenKind,
} from './config.mjs';
import { buildRemoteUrl } from './mcp.mjs';
import { deriveScope } from './scope.mjs';
import { log, err, heading, status, c } from './util.mjs';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

const DEFAULT_ENDPOINT_HINT = 'https://<project-ref>.supabase.co/functions/v1/mcp';

export async function install(args) {
  const root = resolveProjectRoot(args.dir);
  const nonInteractive = Boolean(args.yes) || !process.stdin.isTTY;

  heading('LoreKit install');
  log(`  project: ${c.dim(root)}`);

  // 1. Connection details.
  let { endpoint, token } = resolveConnection(args);

  if (!endpoint) {
    if (nonInteractive) {
      err(
        `\n${c.red('Missing endpoint.')} Pass --endpoint ${DEFAULT_ENDPOINT_HINT} ` +
          `or set LOREKIT_MCP_URL.`,
      );
      return 1;
    }
    endpoint = await ask(`  LoreKit MCP endpoint [${DEFAULT_ENDPOINT_HINT}]: `);
    if (!endpoint) endpoint = DEFAULT_ENDPOINT_HINT;
  }
  if (!token && !nonInteractive) {
    token = await ask('  LoreKit token (lk_rw_… to allow writes, blank to skip): ');
    token = token || null;
  }

  // 2. Install the skill files.
  const dest = skillInstallDir(root);
  const skillExisted = fs.existsSync(path.join(dest, 'SKILL.md'));
  copyDir(SKILL_SOURCE, dest, { force: Boolean(args.force) });

  // 3. Wire .mcp.json.
  const remoteUrl = buildRemoteUrl(endpoint, token);
  const { file, existed } = upsertMcpServer(root, remoteUrl);

  // 4. Report.
  heading('Done');
  status('pass', `skill ${SKILL_NAME}`, `${skillExisted ? 'updated' : 'installed'} → ${path.relative(root, dest) || dest}`);
  status('pass', '.mcp.json', `${existed ? 'updated' : 'created'} lorekit server → ${path.relative(root, file) || file}`);

  const kind = tokenKind(token);
  if (kind === 'none') {
    status('warn', 'token', 'none configured — reads/writes will fail until a token is set');
  } else if (kind === 'read-only') {
    status('warn', 'token', 'read-only (lk_ro_*) — the skill can read lessons but not write them');
  } else if (kind === 'unknown') {
    status('warn', 'token', 'unrecognized prefix — expected lk_rw_* or lk_ro_*');
  } else {
    status('pass', 'token', 'read+write (lk_rw_*)');
  }

  const scope = deriveScope(root);
  if (scope.hasRemote) {
    status('info', 'scope', `${scope.repoScope}${scope.branchScope ? `  ·  ${scope.branchScope}` : ''}`);
  } else {
    status('warn', 'scope', 'no git remote — lessons will fall back to global');
  }

  log(`\n  Next: ${c.cyan('npx @lorekit/cli doctor')} to verify the connection.`);
  if (token) {
    log(`  ${c.dim('Note: your token now lives in .mcp.json — keep it out of version control.')}`);
  }
  return 0;
}
