// `lorekit install` — scaffold the skills and wire the MCP server.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import {
  SKILLS,
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
  mcpConfigPath,
  readJsonIfExists,
} from './config.mjs';
import { buildRemoteUrl, splitEndpoint } from './mcp.mjs';
import { deriveScope } from './scope.mjs';
import { log, heading, status, select, c } from './util.mjs';

// The MCP server URL is fixed — there is only one hosted LoreKit endpoint.
const LOREKIT_MCP_ENDPOINT = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Detect whether lorekit is already installed for a given scope. Returns an
// object describing what is present so the caller can give precise feedback.
function detectInstalled(root, scope) {
  // Check if at least one skill is present.
  const skillsPresent = SKILLS.filter((skill) =>
    fs.existsSync(path.join(skillInstallDir(root, scope, skill.name), 'SKILL.md')),
  );

  // Check if the MCP server entry exists and extract any configured token.
  // Use a try/catch so a corrupt config file degrades to "not installed"
  // instead of throwing — the user sees a clear error when they actually
  // try to write via upsertMcpServer, which uses the throwing readJsonIfExists.
  const mcpFile = mcpConfigPath(root, scope);
  let mcpConfig = null;
  try { mcpConfig = readJsonIfExists(mcpFile); } catch { /* corrupt — treat as absent */ }
  const mcpServer = mcpConfig && mcpConfig.mcpServers && mcpConfig.mcpServers.lorekit;
  const serverArgs = mcpServer && Array.isArray(mcpServer.args) ? mcpServer.args : [];
  const serverUrl = serverArgs.find((a) => typeof a === 'string' && /^https?:\/\//.test(a));
  const existingToken = serverUrl ? splitEndpoint(serverUrl).token : null;

  return {
    hasSkills: skillsPresent.length > 0,
    skillCount: skillsPresent.length,
    totalSkills: SKILLS.length,
    hasMcp: Boolean(mcpServer),
    existingToken,
    isFullyInstalled: skillsPresent.length === SKILLS.length && Boolean(mcpServer),
  };
}

export async function install(args) {
  const root = resolveProjectRoot(args.dir);
  const nonInteractive = Boolean(args.yes) || !process.stdin.isTTY;
  const force = Boolean(args.force);

  heading('LoreKit install');
  log(`  project: ${c.dim(root)}`);

  // 1. Scope: this project, or user-global (every project). --global / --project
  //    force it; otherwise prompt when interactive, else default to project.
  let scope = args.global ? 'global' : args.project ? 'project' : null;
  if (!scope) {
    if (nonInteractive) {
      scope = 'project';
    } else {
      scope = await select('Install LoreKit for…', [
        { label: 'This project', value: 'project', hint: 'this repo only (.claude, .mcp.json)' },
        { label: 'All projects (global)', value: 'global', hint: 'every project (~/.claude)' },
      ]);
    }
  }

  // 2. Already-installed detection — check both scopes so we can give accurate
  //    context ("installed globally but not for this project", etc.).
  const projectState = detectInstalled(root, 'project');
  const globalState = detectInstalled(root, 'global');
  const currentState = scope === 'global' ? globalState : projectState;

  if (currentState.isFullyInstalled && !force) {
    // Surface a clear, useful already-installed summary.
    log('');
    log(
      `  ${c.green('LoreKit is already installed')} for ${
        scope === 'global'
          ? 'all projects (global)'
          : 'this project'
      }.`,
    );

    // Cross-scope awareness: tell the user what's installed where.
    if (scope === 'project' && globalState.isFullyInstalled) {
      log(`  ${c.dim('Also installed globally — skills and MCP server are active for every project.')}`);
    } else if (scope === 'project' && globalState.hasMcp) {
      log(`  ${c.dim('Partially installed globally (MCP server present, but skills may be missing).')}`);
    } else if (scope === 'global' && projectState.isFullyInstalled) {
      log(`  ${c.dim('Also installed for this project (.claude, .mcp.json).')}`);
    } else if (scope === 'global' && projectState.hasMcp) {
      log(`  ${c.dim('Partially installed for this project (MCP server present, but skills may be missing).')}`);
    }

    // Surface the configured token state so the user knows what access they have.
    const kind = tokenKind(currentState.existingToken);
    if (kind === 'read-write') {
      log(`  ${c.dim('Token: read+write (lk_rw_*)')}`);
    } else if (kind === 'read-only') {
      log(`  ${c.dim('Token: read-only (lk_ro_*) — writes will fail until a read+write token is set')}`);
    } else if (kind === 'write-only') {
      log(`  ${c.dim('Token: write-only (lk_wo_*) — reads will fail until a read+write token is set')}`);
    } else if (kind === 'unknown') {
      log(`  ${c.dim('Token: unrecognized prefix — expected lk_rw_*, lk_ro_*, or lk_wo_*')}`);
    } else {
      log(`  ${c.yellow('Token: none configured — reads/writes will fail until a token is set')}`);
    }

    log('');
    log(`  Run ${c.cyan('npx @lorekit/cli doctor')} to verify the connection.`);
    log(`  Pass ${c.cyan('--force')} to reinstall and overwrite existing files.`);
    return 0;
  }

  // Partial install — note what's already there vs what will be added.
  if ((currentState.hasSkills || currentState.hasMcp) && !force) {
    const partialNote =
      currentState.hasSkills && !currentState.hasMcp
        ? `Skills already present (${currentState.skillCount}/${currentState.totalSkills}) — wiring MCP server.`
        : currentState.hasMcp && !currentState.hasSkills
          ? 'MCP server already configured — installing skill files.'
          : `Partially installed (${currentState.skillCount}/${currentState.totalSkills} skills, MCP ${currentState.hasMcp ? 'present' : 'missing'}) — completing setup.`;
    log(`\n  ${c.dim(partialNote)}`);
  }

  log(
    `  install: ${c.dim(
      scope === 'global' ? 'global — ~/.claude, applies to every project' : 'project — this repo only',
    )}`,
  );

  // 3. Connection details.
  //    The endpoint is always the fixed hosted LoreKit URL — no need to ask.
  //    The token is reused from the existing config when already present; the
  //    user only needs to supply it on a fresh install (or to replace it).
  const fromArgs = resolveConnection(args);
  const endpoint = fromArgs.endpoint || LOREKIT_MCP_ENDPOINT;

  // Token resolution order: --token flag → env → existing config → prompt.
  let token = fromArgs.token;
  if (!token && currentState.existingToken) {
    // Reuse the token that's already in the config — don't make the user repeat
    // it just because they're running install again.
    token = currentState.existingToken;
    log(`  ${c.dim('Token: reusing existing token from config.')}`);
  }
  if (!token && !nonInteractive) {
    token = await ask('  LoreKit token (lk_rw_… to allow writes, blank to skip): ');
    token = token || null;
  }

  // 4. Install the skill files — every skill the CLI ships.
  const skillResults = SKILLS.map((skill) => {
    const dest = skillInstallDir(root, scope, skill.name);
    const existed = fs.existsSync(path.join(dest, 'SKILL.md'));
    const written = copyDir(skill.source, dest, { force });
    return { name: skill.name, dest, existed, written };
  });

  // 5. Wire the MCP config for the chosen scope.
  const remoteUrl = buildRemoteUrl(endpoint, token);
  const { file, existed } = upsertMcpServer(root, remoteUrl, scope);

  // 5b. Wire the deterministic hooks (unless --no-hooks). This is the layer the
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

  // 6. Report.
  heading('Done');
  for (const s of skillResults) {
    const skillState = !s.existed
      ? 'installed'
      : s.written > 0
        ? `updated (${s.written} file(s) written)`
        : 'already up to date';
    status(s.existed && s.written === 0 ? 'info' : 'pass', `skill ${s.name}`, `${skillState} → ${display(s.dest)}`);
  }
  status('pass', mcpLabel, `${existed ? 'updated' : 'created'} lorekit server → ${display(file)}`);

  if (!wireHooks) {
    status('info', 'hooks', 'skipped (--no-hooks) — the skill still works, but memories are model-invoked only');
  } else {
    const n = hooks.added + hooks.updated;
    const hookParts = [
      hooks.added ? `${hooks.added} added` : '',
      hooks.updated ? `${hooks.updated} updated` : '',
    ].filter(Boolean);
    const hookState = n === 0 ? 'already wired' : hookParts.join(', ');
    status(n === 0 ? 'info' : 'pass', 'hooks', `${hookState} → ${display(hooks.file)} (${CLAUDE_HOOK_EVENTS.join(', ')})`);
  }

  const kind = tokenKind(token);
  if (kind === 'none') {
    status('warn', 'token', 'none configured — reads/writes will fail until a token is set');
  } else if (kind === 'read-only') {
    status('warn', 'token', 'read-only (lk_ro_*) — the skill can read memories but not write them');
  } else if (kind === 'write-only') {
    status('warn', 'token', 'write-only (lk_wo_*) — the skill can write memories but not read them');
  } else if (kind === 'unknown') {
    status('warn', 'token', 'unrecognized prefix — expected lk_rw_*, lk_ro_*, or lk_wo_*');
  } else {
    status('pass', 'token', 'read+write (lk_rw_*)');
  }

  const gitScope = deriveScope(root);
  if (gitScope.hasRemote) {
    status('info', 'scope', `${gitScope.repoScope}${gitScope.branchScope ? `  ·  ${gitScope.branchScope}` : ''}`);
  } else {
    status('warn', 'scope', 'no git remote — memories will fall back to global');
  }

  log(`\n  Next: ${c.cyan('npx @lorekit/cli doctor')} to verify the connection.`);
  if (token) {
    log(
      `  ${c.dim(
        scope === 'global'
          ? 'Note: your token is stored in ~/.claude.json (used by every project) — keep that file private.'
          : 'Note: your token is stored in .mcp.json — keep it out of version control.',
      )}`,
    );
  }
  return 0;
}
