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
  upsertWebMcpServer,
  isMcpJsonGitIgnored,
  WEB_TOKEN_ENV_VAR,
  upsertClaudeHooks,
  resolveHookRunner,
  HOOK_MODES,
  hookEventsForMode,
  hookModeFromEvents,
  installedHookEvents,
  resolveConnection,
  tokenKind,
  homeDir,
  mcpConfigPath,
  readJsonIfExists,
  readLorekitServer,
  isWebMcpServerEntry,
} from './config.mjs';
import { buildRemoteUrl, splitEndpoint } from './mcp.mjs';
import { deriveScope } from './scope.mjs';
import { log, heading, status, select, err, c } from './util.mjs';

// The MCP server URL is fixed — there is only one hosted LoreKit endpoint.
const LOREKIT_MCP_ENDPOINT = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Show enough of a token to recognise it, never enough to use it: the
// permission prefix plus the last four characters.
export function maskToken(token) {
  if (!token) return 'none';
  const s = String(token);
  const m = /^(lk_(?:rw|ro|wo)_)/.exec(s);
  const prefix = m ? m[1] : '';
  const tail = s.slice(-4);
  return s.length <= prefix.length + 4 ? `${prefix}…` : `${prefix}…${tail}`;
}

/**
 * How `install` should arrive at the token it writes — the pure decision, so
 * the rule is testable without a pseudo-TTY.
 *
 *   'flag'   → an explicit --token / LOREKIT_TOKEN wins outright.
 *   'choose' → a token is already configured AND this is an interactive
 *              `--force`: ask whether to keep / replace / remove it.
 *   'reuse'  → a token is already configured: reuse it silently.
 *   'prompt' → nothing configured and someone is there to ask.
 *   'none'   → nothing configured and nobody to ask.
 *
 * WHY 'choose' exists: `--force` is what a user runs precisely BECAUSE the
 * current setup is wrong, and the most common way for it to be wrong is a
 * revoked token — which doctor's `authentication` check now names, telling them
 * to come here. Reusing the stored token silently made `--force` incapable of
 * fixing the one thing it was reached for, and no other command could either.
 * It stays interactive-only: a non-interactive run has nobody to answer, so it
 * keeps the old reuse behaviour and `--token` remains the way to replace a
 * token in a script.
 */
export function tokenPlan({ flagToken, existingToken, force, nonInteractive } = {}) {
  if (flagToken) return { action: 'flag', token: flagToken };
  if (existingToken) {
    if (force && !nonInteractive) return { action: 'choose', token: existingToken };
    return { action: 'reuse', token: existingToken };
  }
  return nonInteractive ? { action: 'none', token: null } : { action: 'prompt', token: null };
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

// The interactive hook choice, as data so it can be asserted on without a pty.
//
// Deliberately THREE options, not a yes/no: `SessionStart` is a pure read that
// injects existing lessons, while the other two only nudge. A single yes/no
// bundles them, so a user who declines because they don't want to be nudged
// also loses lesson injection — the thing LoreKit is for. Each hint says what
// the hooks DO (inject context, nudge); none of them writes memory, and copy
// that implied otherwise would ask for consent to something that never happens.
export const HOOK_PROMPT_OPTIONS = [
  {
    label: 'Yes, all of them',
    value: 'all',
    hint: 'inject lessons at session start; nudge on a tool failure and at end of turn',
  },
  {
    label: 'Read-only',
    value: 'read-only',
    hint: 'inject lessons at session start; never nudge',
  },
  {
    label: 'No hooks',
    value: 'none',
    hint: 'skills + MCP only; memory stays model-invoked',
  },
];

// Pure: which hook mode should the interactive prompt preselect?
//
// The default is the DETECTED state, not a constant — `install` is explicitly
// re-runnable (token refresh, `--force`, completing a partial install), so a
// constant "all" would silently resurrect hooks a user previously declined.
// A genuinely fresh install has nothing to detect, so it preselects `all`: that
// is the "opt in by default" the prompt is there to promote. A hand-wired subset
// that matches no preset (`custom`) preselects `all` too — there is no preset to
// re-offer, and the user still sees and chooses from the three options.
//
// That last clause is load-bearing and INTERACTIVE-ONLY: it is safe precisely
// because the user is then shown the list and picks. A `--yes` / non-TTY run has
// no such moment, so it must NOT take this value for a `custom` set — see
// `install`, which leaves a hand-wired wiring untouched instead.
export function defaultHookMode({ freshInstall, wiredEvents }) {
  if (freshInstall) return 'all';
  const detected = hookModeFromEvents(wiredEvents);
  return detected === 'custom' ? 'all' : detected;
}

// Resolve the requested hook mode from the flags, or null when nothing was
// specified (the caller then prompts / falls back). `--hooks <mode>` is the
// explicit selector; `--no-hooks` is the pre-existing boolean and keeps its
// documented SKIP semantics — it never removes hooks that are already wired,
// which is why it maps to `none` here but is tracked separately below.
//
// A VALUELESS `--hooks` is a usage error, not an absent flag. `hooks` is not in
// `parseArgs`' `booleans` list, so `--hooks --yes` and a trailing `--hooks`
// both yield `true` and `--hooks=` yields `''`. Returning null for those would
// resolve to the DETECTED mode — the exact silent fallback the validation below
// exists to prevent — so they are surfaced as the sentinel `INVALID_HOOK_MODE`
// and rejected alongside `--hooks bogus`. Mirrors `write.mjs`'s bare
// `--ttl-days`, which feeds NaN to its validator for the same reason: an
// explicitly supplied flag is a caller assertion, so a malformed one must fail.
export const INVALID_HOOK_MODE = '(missing value)';

function requestedHookMode(args) {
  const raw = args.hooks;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().toLowerCase();
  if (raw !== undefined && raw !== false) return INVALID_HOOK_MODE;
  if (args['no-hooks']) return 'none';
  return null;
}

export async function install(args) {
  const root = resolveProjectRoot(args.dir);
  const nonInteractive = Boolean(args.yes) || !process.stdin.isTTY;
  const force = Boolean(args.force);

  // Validate `--hooks` before touching anything on disk: a mistyped mode must
  // fail loudly, never silently fall back to a different wiring than asked for.
  const requestedMode = requestedHookMode(args);
  if (requestedMode === INVALID_HOOK_MODE) {
    err(`\n  --hooks needs a mode. Valid modes: ${HOOK_MODES.join(' | ')}.`);
    return 1;
  }
  if (requestedMode !== null && !HOOK_MODES.includes(requestedMode)) {
    err(`\n  Unknown --hooks mode "${requestedMode}". Valid modes: ${HOOK_MODES.join(' | ')}.`);
    return 1;
  }
  // An explicit `--hooks` IS the intent to change the wiring, so it must reach
  // the hook step even on an otherwise complete install (which normally short-
  // circuits). `--no-hooks` is skip-only and never justifies that bypass.
  const hooksFlagExplicit = typeof args.hooks === 'string' && args.hooks.trim() !== '';

  // `--mcp-json` writes a committable, env-var-referencing project .mcp.json for
  // Claude Code on the web (see upsertWebMcpServer). It is an explicit intent to
  // (re)write that file, so — like an explicit `--hooks` — it must reach the
  // write step even when the scope is already fully installed.
  const writeWebMcpJson = Boolean(args['mcp-json']);

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

  const wiredEvents = installedHookEvents(root, scope);

  if (currentState.isFullyInstalled && !force && !hooksFlagExplicit && !writeWebMcpJson) {
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

    // Hooks are a user choice now, so an already-installed run must SAY which
    // one is in effect — otherwise "why does nothing get remembered?" has no
    // answer here and the user has to go read settings.json.
    log(
      wiredEvents.length > 0
        ? `  ${c.dim(`Hooks: ${wiredEvents.join(', ')}`)}`
        : `  ${c.dim('Hooks: none wired — the skills work, but only when the model invokes them')}`,
    );

    log('');
    log(`  Run ${c.cyan('npx @lorekit/cli doctor')} to verify the connection.`);
    log(`  Change the hooks with ${c.cyan(`--hooks ${HOOK_MODES.join('|')}`)}.`);
    log(`  Pass ${c.cyan('--force')} to reinstall and overwrite existing files.`);
    return { exitCode: 0, 'lorekit.cli.hooks_mode': hookModeFromEvents(wiredEvents) };
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
  const plan = tokenPlan({
    flagToken: fromArgs.token,
    existingToken: currentState.existingToken,
    force,
    nonInteractive,
  });

  let token = null;
  if (plan.action === 'flag') {
    token = plan.token;
  } else if (plan.action === 'reuse') {
    token = plan.token;
    log(`  ${c.dim('Token: reusing existing token from config.')}`);
  } else if (plan.action === 'choose') {
    const choice = await select(
      `A token is already configured (${maskToken(currentState.existingToken)}). What should this reinstall do?`,
      [
        { label: 'Keep the existing token', value: 'keep', hint: 'reuse what is in the config' },
        { label: 'Replace it with a new token', value: 'replace', hint: 'paste a fresh lk_… token (e.g. after revoking one)' },
        { label: 'Remove the token', value: 'remove', hint: 'leave the server unauthenticated' },
      ],
    );
    if (choice === 'replace') {
      const entered = await ask('  New LoreKit token (lk_rw_… to allow writes, blank to keep the existing one): ');
      token = entered || currentState.existingToken;
      log(`  ${c.dim(entered ? 'Token: replaced with the token you entered.' : 'Token: nothing entered — keeping the existing token.')}`);
    } else if (choice === 'remove') {
      // Deliberately NOT followed by the fresh-install prompt below: someone who
      // just chose "remove" must not be immediately asked for a token again.
      token = null;
      log(`  ${c.yellow('Token: removed — reads/writes will fail until a token is set.')}`);
    } else {
      token = currentState.existingToken;
      log(`  ${c.dim('Token: reusing existing token from config.')}`);
    }
  } else if (plan.action === 'prompt') {
    const entered = await ask('  LoreKit token (lk_rw_… to allow writes, blank to skip): ');
    token = entered || null;
  }

  // 4. Install the skill files — every skill the CLI ships.
  const skillResults = SKILLS.map((skill) => {
    const dest = skillInstallDir(root, scope, skill.name);
    const existed = fs.existsSync(path.join(dest, 'SKILL.md'));
    const written = copyDir(skill.source, dest, { force });
    return { name: skill.name, dest, existed, written };
  });

  // 5. Wire the MCP config for the chosen scope.
  //    When `--mcp-json` is going to (re)write the PROJECT .mcp.json in its
  //    committable form and the scope target IS that same file (project scope),
  //    skip this write — otherwise we would write an embedded-token file only to
  //    overwrite it with the committable one a moment later. A global scope
  //    targets ~/.claude.json, a different file, so it always writes.
  const remoteUrl = buildRemoteUrl(endpoint, token);
  const scopeWriteOwnedByWeb = writeWebMcpJson && scope === 'project';
  let file = null;
  let existed = false;
  if (!scopeWriteOwnedByWeb) {
    // A plain project install embeds the token in .mcp.json. If that file
    // currently holds the committable web form (written by an earlier
    // `--mcp-json`), this write replaces it with an embedded secret — in the
    // very file the docs tell you to commit. Warn before clobbering it;
    // `isWebMcpServerEntry` recognises the shape we are about to overwrite.
    if (scope === 'project' && token) {
      const prior = readLorekitServer(root);
      if (prior && isWebMcpServerEntry(prior.server)) {
        status(
          'warn',
          '.mcp.json',
          `replacing the committable web entry with an embedded token — do not commit this file, or re-run with --mcp-json to keep the \${${WEB_TOKEN_ENV_VAR}} form`,
        );
      }
    }
    ({ file, existed } = upsertMcpServer(root, remoteUrl, scope));
  }

  // 5a. `--mcp-json`: write the committable, env-var-referencing project
  //     .mcp.json for Claude Code on the web (see upsertWebMcpServer). Always
  //     the repo-root file, regardless of scope — that is the only MCP config a
  //     fresh web clone can see. The token is NOT embedded here: the file
  //     references `${LOREKIT_TOKEN}`, set as an environment secret in the web UI.
  let webMcp = null;
  if (writeWebMcpJson) {
    webMcp = upsertWebMcpServer(root, endpoint, WEB_TOKEN_ENV_VAR);
  }

  // 5b. Hooks — the deterministic layer the Claude plugin adds on top of the
  //     skill, firing the shared `lorekit hook` engine (which reads the same
  //     config). NONE of them write memory: SessionStart injects existing
  //     lessons, PostToolUseFailure surfaces relevant ones plus a write nudge,
  //     Stop fires the friction-gated retrospective nudge. All three only emit
  //     context — the write is still the model calling `memory.write`. The
  //     prompt copy below says exactly that, because a user who declines
  //     "automatic memory writing" would be declining something that never
  //     happens and losing lesson injection, which is the product.
  let hookMode = requestedMode;
  // A hand-wired set matching no preset (`custom`) is the one state the three
  // options cannot express. Interactively that is fine — `defaultHookMode`
  // preselects `all` and the user still chooses. A `--yes` / non-TTY run never
  // gets that moment, so taking the preselection there would WIRE `all` and
  // silently re-add the events the user hand-removed — exactly what
  // `hookModeFromEvents` tells callers not to do, and the opposite of the
  // documented "otherwise whatever is already wired". So keep exactly that set
  // — no event added or removed, though the command string is still refreshed
  // below; `--hooks <mode>` remains the way to change it on purpose.
  let preserveCustomHooks = false;
  if (hookMode === null) {
    const preselect = defaultHookMode({
      freshInstall: !currentState.hasSkills && !currentState.hasMcp && wiredEvents.length === 0,
      wiredEvents,
    });
    if (nonInteractive) {
      preserveCustomHooks = hookModeFromEvents(wiredEvents) === 'custom';
      hookMode = preserveCustomHooks ? 'custom' : preselect;
    } else {
      log('');
      hookMode = await select('Install the LoreKit lifecycle hooks?', HOOK_PROMPT_OPTIONS, {
        defaultIndex: Math.max(0, HOOK_PROMPT_OPTIONS.findIndex((o) => o.value === preselect)),
      });
    }
  }

  // `hookEventsForMode` maps any unknown mode to the full set, so `custom` must
  // never reach it — the preserved wiring IS the event list here.
  const hookEvents = preserveCustomHooks ? [...wiredEvents] : hookEventsForMode(hookMode);
  // `--no-hooks` is skip-only by contract: it has always meant "don't wire
  // them", never "take away the ones already there". An interactive `No hooks`
  // (or an explicit `--hooks none`) is an unambiguous request to remove.
  const skipHooksOnly = hookMode === 'none' && Boolean(args['no-hooks']) && !hooksFlagExplicit;
  // Nothing to wire and nothing to remove ⇒ don't create a settings.json at all.
  // `wiredEvents` reads as empty for an unparseable settings.json, so a `none`
  // run against one is a silent no-op — correct, not a gap: Claude Code cannot
  // parse that file either, so no lorekit hook is firing from it. Any mode that
  // WIRES still goes through `upsertClaudeHooks`, whose throwing read surfaces
  // the parse error rather than clobbering the file.
  //
  // Preserving a `custom` set does NOT mean skipping the write. Passing
  // `hookEvents` (== `wiredEvents` here) keeps exactly that set — nothing is
  // added, and the prune loop finds no lorekit entry on the events outside it,
  // so `removed` is always 0 — while still REFRESHING a stale command string.
  // Skipping the call instead left a `--force` re-install unable to repair a
  // hook command pointing at an old runner, which is the one thing a re-install
  // is for.
  const touchHooks = !skipHooksOnly && (hookEvents.length > 0 || wiredEvents.length > 0);
  let hooks = null;
  if (touchHooks) {
    hooks = upsertClaudeHooks(root, scope, resolveHookRunner(), hookEvents);
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
  if (file) {
    status('pass', mcpLabel, `${existed ? 'updated' : 'created'} lorekit server → ${display(file)}`);
  }
  if (webMcp) {
    // The committable web form: reported separately so it is clear this file is
    // meant to be committed (unlike the embedded-token form) and that the token
    // comes from an environment secret rather than the file.
    const webPath = path.relative(root, webMcp.file) || webMcp.file;
    status(
      'pass',
      '.mcp.json (web)',
      `${webMcp.existed ? 'updated' : 'created'} committable lorekit server (auth via \${${WEB_TOKEN_ENV_VAR}}) → ${webPath}`,
    );
    // The web file only works if it is actually committed, and .mcp.json is
    // commonly git-ignored (the embedded-token form is a secret). Warn when it
    // is, so a fresh web clone silently missing the config is not a mystery.
    if (isMcpJsonGitIgnored(root) === true) {
      status(
        'warn',
        '.mcp.json (git)',
        'git-ignored — un-ignore it (add `!.mcp.json` to .gitignore, or `git add -f .mcp.json`) or a fresh web clone will not see it',
      );
    }
  }

  if (!touchHooks) {
    status(
      'info',
      'hooks',
      skipHooksOnly
        ? 'skipped (--no-hooks) — the skills still work, but memory stays model-invoked'
        : 'none — the skills still work, but memory stays model-invoked',
    );
  } else {
    const n = hooks.added + hooks.updated + hooks.removed + hooks.deduped;
    // `deduped` is reported separately from `removed`: removed is a wiring the
    // user asked for (a downgrade), deduped is a repair of a settings file that
    // was firing the same hook twice — silently fixing that would leave the
    // doubled output they came here about unexplained.
    const hookParts = [
      hooks.added ? `${hooks.added} added` : '',
      hooks.updated ? `${hooks.updated} updated` : '',
      hooks.removed ? `${hooks.removed} removed` : '',
      hooks.deduped ? `${hooks.deduped} duplicate(s) removed` : '',
    ].filter(Boolean);
    const hookState = n === 0 ? 'already wired' : hookParts.join(', ');
    const wired = hookEvents.length > 0 ? ` (${hookEvents.join(', ')})` : '';
    // The preserved-`custom` run DOES write, so it lands here rather than in the
    // "left as-is" branch — but it is still the one state the three modes cannot
    // express, so it keeps its own explanation of how to leave it.
    const kept = preserveCustomHooks
      ? `; a hand-wired set matching no preset, pass --hooks ${HOOK_MODES.join('|')} to change it`
      : '';
    status(
      n === 0 ? 'info' : 'pass',
      `hooks ${hookMode}`,
      `${hookState} → ${display(hooks.file)}${wired}${kept}`,
    );
  }

  const kind = tokenKind(token);
  if (scopeWriteOwnedByWeb) {
    // `--project --mcp-json`: the committable web .mcp.json is the ONLY config
    // written, and it references ${LOREKIT_TOKEN} rather than storing a token —
    // so NOTHING persists a credential here. Reporting the token's tier would
    // imply it was configured; instead say it is not stored (and that a passed
    // --token was therefore not persisted), pointing at the environment secret.
    status(
      'warn',
      'token',
      `not stored — the committable .mcp.json resolves \${${WEB_TOKEN_ENV_VAR}} at runtime; set it as an environment secret${
        plan.action === 'flag' ? ' (the token you supplied is not persisted)' : ''
      }`,
    );
  } else if (kind === 'none') {
    // A global --mcp-json with no token still writes the web file; explain the
    // runtime resolution rather than implying reads/writes will fail.
    status(
      'warn',
      'token',
      webMcp
        ? `none stored — the committable .mcp.json resolves \${${WEB_TOKEN_ENV_VAR}} at runtime; set it as an environment secret`
        : 'none configured — reads/writes will fail until a token is set',
    );
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
  // Where the token lives, and how to treat that file, depends on which MCP
  // configs were written. The web `.mcp.json` never holds the token, so a
  // project scope that was owned by `--mcp-json` gets the web guidance, not the
  // "keep it out of version control" note that applies to the embedded form.
  if (webMcp) {
    log(
      `  ${c.dim(
        `For Claude Code on the web: commit .mcp.json (it is often git-ignored — un-ignore it first), then set ${WEB_TOKEN_ENV_VAR} as an environment secret. The file references the token, so it never holds the secret itself.`,
      )}`,
    );
  }
  if (token && scope === 'global') {
    log(
      `  ${c.dim('Note: your token is stored in ~/.claude.json (used by every project) — keep that file private.')}`,
    );
  } else if (token && scope === 'project' && !scopeWriteOwnedByWeb) {
    log(
      `  ${c.dim('Note: your token is stored in .mcp.json — keep it out of version control.')}`,
    );
  }
  // Bounded, non-PII: which of the three presets this run landed on. Counting
  // the `--no-hooks` FLAG (as telemetry already did) says nothing about what a
  // user picks when actually asked, which is the whole point of the prompt.
  return { exitCode: 0, 'lorekit.cli.hooks_mode': hookMode };
}
