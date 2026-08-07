// `lorekit uninstall` — reverse `install`: remove the skill, the MCP server
// entry, and the lifecycle hooks for the chosen scope. Surgical — every other
// server, hook, and setting is left untouched.
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import {
  SKILLS,
  resolveProjectRoot,
  removeSkill,
  removeMcpServer,
  removeWebMcpServer,
  removeClaudeHooks,
  homeDir,
} from './config.mjs';
import { log, heading, status, c } from './util.mjs';

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

export async function uninstall(args) {
  const root = resolveProjectRoot(args.dir);
  const nonInteractive = Boolean(args.yes) || !process.stdin.isTTY;

  heading('LoreKit uninstall');
  log(`  project: ${c.dim(root)}`);

  // Mirror install's scope selection: --project / --global force it, else
  // prompt when interactive, else default to project.
  let scope = args.global ? 'global' : args.project ? 'project' : null;
  if (!scope) {
    if (nonInteractive) {
      scope = 'project';
    } else {
      const ans = (
        await ask('  Remove from this project or the global install? [project/global] (project): ')
      ).toLowerCase();
      scope = ans.startsWith('g') ? 'global' : 'project';
    }
  }
  log(
    `  scope: ${c.dim(
      scope === 'global' ? 'global — ~/.claude, applies to every project' : 'project — this repo only',
    )}`,
  );

  // Each removal is independent and best-effort: a corrupt or unwritable config
  // for one target must not crash the run or block the others. `removeMcpServer`
  // / `removeClaudeHooks` throw on an unparseable file (the same fail-safe as
  // install — never clobber what we can't understand), so we catch and report it
  // cleanly, leaving that file byte-for-byte untouched. Atomic writes
  // (writeFileAtomic) guarantee a config can't be half-written even on a crash.
  const skillSteps = SKILLS.map((skill) => ({
    name: skill.name,
    step: attempt(() => removeSkill(root, scope, skill.name)),
  }));
  const mcp = attempt(() => removeMcpServer(root, scope));
  // `install --global --mcp-json` writes the committable project .mcp.json in
  // ADDITION to ~/.claude.json, so a GLOBAL uninstall must also clear that
  // entry or it orphans a lorekit server pointing at a now-removed setup. A
  // project uninstall already targets .mcp.json via `mcp` above, so this is
  // global-only. `removeWebMcpServer` removes ONLY the committable web form, so
  // it never deletes an unrelated embedded-token `install --project` entry a
  // user set up separately. Surgical and idempotent: no web file ⇒ a quiet
  // "nothing to remove", other servers in the file are preserved.
  const webMcp = scope === 'global' ? attempt(() => removeWebMcpServer(root)) : null;
  const hooks = attempt(() => removeClaudeHooks(root, scope));

  // Global paths shown relative to ~; project paths repo-relative.
  const display = (p) =>
    scope === 'global' ? p.replace(homeDir(), '~') : path.relative(root, p) || p;
  const mcpLabel = scope === 'global' ? '~/.claude.json' : '.mcp.json';

  heading('Done');
  for (const { name, step } of skillSteps) {
    report(step, `skill ${name}`, {
      done: (r) => `removed → ${display(r.dest)}`,
      noop: 'not installed — nothing to remove',
    });
  }
  report(mcp, mcpLabel, {
    done: (r) => `lorekit server removed → ${display(r.file)}`,
    noop: 'no lorekit server entry — nothing to remove',
  });
  if (webMcp) {
    // Always the repo-relative project path, even under a global uninstall.
    report(webMcp, '.mcp.json (web)', {
      done: (r) => `lorekit server removed → ${path.relative(root, r.file) || r.file}`,
      noop: 'no committable project .mcp.json — nothing to remove',
    });
  }
  report(hooks, 'hooks', {
    done: (r) => `${r.removed} removed → ${display(r.file)}`,
    noop: 'no lorekit hooks — nothing to remove',
  });

  const skillStepList = skillSteps.map((s) => s.step);
  const webSteps = webMcp ? [webMcp] : [];
  const failed = [...skillStepList, mcp, ...webSteps, hooks].some((s) => !s.ok);
  const any =
    (skillStepList.some((s) => s.result?.removed) ||
      mcp.result?.removed ||
      webMcp?.result?.removed ||
      hooks.result?.removed) && true;

  if (failed) {
    log(`\n  ${c.dim('Some items could not be removed and were left untouched — see above.')}`);
    return 1;
  }
  if (!any) {
    const other = scope === 'global' ? '--project' : '--global';
    log(`\n  ${c.dim(`Nothing found for the ${scope} scope — try ${other}?`)}`);
  } else {
    log(`\n  ${c.dim('Removed. Your other MCP servers, hooks, and settings were left untouched.')}`);
    log(`  ${c.dim('Note: your token may remain in shell history or env — rotate it if it leaked.')}`);
  }
  return 0;
}

// Run a removal step, converting a throw into a reportable outcome so one bad
// config can't crash the whole uninstall or leave a stack trace on screen.
function attempt(fn) {
  try {
    return { ok: true, result: fn() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// Render one status line for a step: a clean error (file left untouched), a
// "removed" line, or a "nothing to remove" line.
function report(step, label, { done, noop }) {
  if (!step.ok) {
    status('fail', label, `left untouched — ${step.error.message}`);
    return;
  }
  const r = step.result;
  const removed = r.removed;
  status(removed ? 'pass' : 'info', label, removed ? done(r) : noop);
}
