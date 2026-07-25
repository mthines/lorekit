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
  upsertClaudeHooks,
  resolveHookRunner,
  CLAUDE_HOOK_EVENTS,
  resolveConnection,
  tokenKind,
  homeDir,
} from './config.mjs';
import { buildRemoteUrl } from './mcp.mjs';
import { deriveScope } from './scope.mjs';
import { log, err, heading, status, c } from './util.mjs';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

const DEFAULT_ENDPOINT_HINT = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

export async function install(args) {
  const root = resolveProjectRoot(args.dir);
  const nonInteractive = Boolean(args.yes) || !process.stdin.isTTY;

  heading('LoreKit install');
  log(`  project: ${c.dim(root)}`);

  // 1. Scope: this project, or user-global (every project). --global / --project
  //    force it; otherwise prompt when interactive, else default to project.
  let scope = args.global ? 'global' : args.project ? 'project' : null;
  if (!scope) {
    if (nonInteractive) {
      scope = 'project';
    } else {
      const ans = (
        await ask('  Install for this project or globally for all projects? [project/global] (project): ')
      ).toLowerCase();
      scope = ans.startsWith('g') ? 'global' : 'project';
    }
  }
  log(
    `  install: ${c.dim(
      scope === 'global' ? 'global — ~/.claude, applies to every project' : 'project — this repo only',
    )}`,
  );

  // 2. Connection details.
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

  // 3. Install the skill files.
  const dest = skillInstallDir(root, scope);
  const skillExisted = fs.existsSync(path.join(dest, 'SKILL.md'));
  const written = copyDir(SKILL_SOURCE, dest, { force: Boolean(args.force) });

  // 4. Wire the MCP config for the chosen scope.
  const remoteUrl = buildRemoteUrl(endpoint, token);
  const { file, existed } = upsertMcpServer(root, remoteUrl, scope);

  // 4b. Wire the deterministic hooks (unless --no-hooks). This is the layer the
  //     Claude plugin adds on top of the skill: lessons injected on every
  //     SessionStart, a nudge on tool failure, a retrospective nudge on Stop —
  //     firing the shared `lorekit hook` engine, which reads the same config.
  const wireHooks = !args['no-hooks'];
  let hooks = null;
  if (wireHooks) {
    hooks = upsertClaudeHooks(root, scope, resolveHookRunner());
  }

  // Show global paths relative to ~ (a repo-relative path would be a mess of
  // ../../); project paths stay repo-relative.
  const display = (p) =>
    scope === 'global' ? p.replace(homeDir(), '~') : path.relative(root, p) || p;
  const mcpLabel = scope === 'global' ? '~/.claude.json' : '.mcp.json';

  // 5. Report.
  heading('Done');
  const skillState = !skillExisted
    ? 'installed'
    : written > 0
      ? `updated (${written} file(s) written)`
      : 'unchanged — pass --force to overwrite';
  status(skillExisted && written === 0 ? 'info' : 'pass', `skill ${SKILL_NAME}`, `${skillState} → ${display(dest)}`);
  status('pass', mcpLabel, `${existed ? 'updated' : 'created'} lorekit server → ${display(file)}`);

  if (!wireHooks) {
    status('info', 'hooks', 'skipped (--no-hooks) — the skill still works, but lessons are model-invoked only');
  } else {
    const n = hooks.added + hooks.updated;
    const hookState =
      n === 0
        ? 'unchanged — already wired'
        : `${hooks.added ? `${hooks.added} added` : ''}${hooks.added && hooks.updated ? ', ' : ''}${hooks.updated ? `${hooks.updated} updated` : ''}`;
    status(n === 0 ? 'info' : 'pass', 'hooks', `${hookState} → ${display(hooks.file)} (${CLAUDE_HOOK_EVENTS.join(', ')})`);
  }

  const kind = tokenKind(token);
  if (kind === 'none') {
    status('warn', 'token', 'none configured — reads/writes will fail until a token is set');
  } else if (kind === 'read-only') {
    status('warn', 'token', 'read-only (lk_ro_*) — the skill can read lessons but not write them');
  } else if (kind === 'write-only') {
    status('warn', 'token', 'write-only (lk_wo_*) — the skill can write lessons but not read them');
  } else if (kind === 'unknown') {
    status('warn', 'token', 'unrecognized prefix — expected lk_rw_*, lk_ro_*, or lk_wo_*');
  } else {
    status('pass', 'token', 'read+write (lk_rw_*)');
  }

  const gitScope = deriveScope(root);
  if (gitScope.hasRemote) {
    status('info', 'scope', `${gitScope.repoScope}${gitScope.branchScope ? `  ·  ${gitScope.branchScope}` : ''}`);
  } else {
    status('warn', 'scope', 'no git remote — lessons will fall back to global');
  }

  log(`\n  Next: ${c.cyan('npx @lorekit/cli doctor')} to verify the connection.`);
  if (token) {
    log(
      `  ${c.dim(
        scope === 'global'
          ? 'Note: your token now lives in ~/.claude.json (used by every project) — keep that file private.'
          : 'Note: your token now lives in .mcp.json — keep it out of version control.',
      )}`,
    );
  }
  return 0;
}
