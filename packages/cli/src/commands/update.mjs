// `lorekit update` — refresh the bundled skills (and their hook wiring) to the
// versions shipped with the running CLI.
//
// Fully offline: the shipped skill source travels in the SAME npm tarball as
// this running CLI (`SKILLS[].source` in `shared/config.mjs`), so "installed
// vs shipped" is a filesystem compare with zero network calls — see
// `shared/skill-versions.mjs`, the same module `doctor` and the SessionStart
// drift nudge (`core/update-notify.mjs`) read through, so all three surfaces
// agree on what counts as outdated.
//
// `--check` is a dry run: report drift, write nothing. Without it, `update`
// first PRUNES any file present in the install that the shipped skill no
// longer ships (`pruneRemoved` — `copyDir` only ever writes, so without this
// a rule file a newer version dropped would survive every future refresh
// forever), then re-copies (force) every skill into whichever scope(s)
// already have an install — reusing `copyDir`, the exact same skill-copy path
// `install` uses, so the two can never drift on what "installing a skill"
// means — and refreshes that scope's hook command string via `upsertClaudeHooks`, the
// same call `install --force` makes. That refresh is deliberately in scope:
// a stale `npx -y @lorekit/cli@1.2.3 hook …` pin or an old runner path is the
// same class of drift this command exists to fix, the call is idempotent
// (it only rewrites the command string, never the wired event set), and
// skipping it would leave `update` unable to repair the one other thing an
// install can go stale on. `--project` / `--global` narrow to one scope;
// with neither, every scope that currently has an existing skill install is
// refreshed — `update` never CREATES a fresh install, that stays `install`'s
// job.
import fs from 'node:fs';
import path from 'node:path';
import {
  SKILLS,
  resolveProjectRoot,
  skillInstallDir,
  copyDir,
  installedHookEvents,
  upsertClaudeHooks,
  resolveHookRunner,
} from '../shared/config.mjs';
import { checkSkillVersions, SKILL_SCOPES } from '../shared/skill-versions.mjs';
import { log, heading, status, c } from '../shared/util.mjs';

// Which scopes `update` should touch. Explicit `--project`/`--global` narrow
// to exactly one — but only when that scope actually has something installed;
// naming a scope with nothing in it must still fall through to the "nothing
// to update" report below, never silently report health on an empty scope.
// `--global` is checked first, matching `install`/`uninstall`'s own
// scope-flag precedence, so `--project --global` never picks the opposite
// scope from its sibling commands.
// With neither flag, every scope holding at least one installed skill (any
// state other than `not-installed`) is refreshed.
function targetScopes(args, results) {
  const hasInstall = (scope) => results.some((r) => r.scope === scope && r.state !== 'not-installed');
  if (args.global) return hasInstall('global') ? ['global'] : [];
  if (args.project) return hasInstall('project') ? ['project'] : [];
  return SKILL_SCOPES.filter(hasInstall);
}

// Remove any file under `dest` that no longer exists in `src` before the
// refresh copy. `copyDir` only ever WRITES — it has no delete path — so a
// rule/reference file a newer skill version dropped would otherwise survive
// every future `update` forever, still sitting on disk and still read by the
// agent alongside the content that superseded it, while `update` reports a
// clean "already up to date" or a green "refreshed". Safe to prune
// unconditionally: `update` never touches a scope the caller didn't already
// have installed, and the refresh that follows overwrites everything that
// DOES still exist in `src` anyway (`--force`), so nothing reachable from the
// shipped skill is ever at risk — only content the shipped skill no longer
// ships is removed.
// `dryRun: true` counts what WOULD be removed without touching disk — the
// preview `--check` shows for the one destructive step `update` takes, so a
// dry run never has to say "outdated" and stay silent about a file the real
// run is about to delete.
function pruneRemoved(src, dest, { dryRun = false } = {}) {
  if (!fs.existsSync(dest)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    const destPath = path.join(dest, entry.name);
    const srcPath = path.join(src, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(srcPath) && fs.statSync(srcPath).isDirectory()) {
        removed += pruneRemoved(srcPath, destPath, { dryRun });
      } else {
        if (!dryRun) fs.rmSync(destPath, { recursive: true, force: true });
        removed++;
      }
    } else if (!fs.existsSync(srcPath)) {
      if (!dryRun) fs.rmSync(destPath, { force: true });
      removed++;
    }
  }
  return removed;
}

const versionLabel = (v) => (v ? `v${v}` : 'unknown');

export async function update(args) {
  const root = resolveProjectRoot(args.dir);
  const dryRun = Boolean(args.check);

  heading(dryRun ? 'LoreKit update (--check)' : 'LoreKit update');
  log(`  project: ${c.dim(root)}`);

  const results = checkSkillVersions(root);
  const scopes = targetScopes(args, results);

  if (scopes.length === 0) {
    log('');
    log(`  ${c.dim('no existing skill install found — nothing to update.')}`);
    log(`  Run ${c.cyan('lorekit install')} for a fresh install.`);
    return { exitCode: 0, 'lorekit.cli.update.scopes': 0, 'lorekit.cli.update.outdated': 0, 'lorekit.cli.update.check': dryRun };
  }

  heading('Skills');
  let outdatedCount = 0;
  let filesWritten = 0;
  let filesRemoved = 0;
  for (const scope of scopes) {
    for (const skill of SKILLS) {
      const entry = results.find((r) => r.scope === scope && r.name === skill.name);
      if (!entry || entry.state === 'not-installed') continue;
      const label = scopes.length > 1 ? `skill ${skill.name} (${scope})` : `skill ${skill.name}`;

      if (entry.state === 'current') {
        status('pass', label, `${versionLabel(entry.installed)} — already up to date`);
        continue;
      }

      outdatedCount++;
      const before = versionLabel(entry.installed);
      const after = versionLabel(entry.shipped);
      const dest = skillInstallDir(root, scope, skill.name);
      if (dryRun) {
        const wouldRemove = pruneRemoved(skill.source, dest, { dryRun: true });
        const removedNote = wouldRemove > 0 ? `, ${wouldRemove} to remove` : '';
        status('warn', label, `${before} → ${after} available${removedNote} — run \`lorekit update\` to refresh`);
        continue;
      }

      const removed = pruneRemoved(skill.source, dest);
      const written = copyDir(skill.source, dest, { force: true });
      filesWritten += written;
      filesRemoved += removed;
      const removedNote = removed > 0 ? `, ${removed} removed` : '';
      status('pass', label, `${before} → ${after} (${written} file(s) written${removedNote})`);
    }
  }

  // Hook command strings — refreshed for real, never on a dry run. Only a
  // scope that already has hooks wired has anything to refresh; a scope with
  // none stays untouched (matching `install`'s own "nothing to wire" no-op).
  // `upsertClaudeHooks` rewrites `.claude/settings.json` unconditionally
  // (formatting included) even when every entry was already `unchanged` —
  // tallying its returned counts is what lets the no-skills-outdated report
  // below say so instead of silently rewriting the file underneath the user.
  let hooksChanged = 0;
  if (!dryRun) {
    for (const scope of scopes) {
      const wired = installedHookEvents(root, scope);
      if (wired.length === 0) continue;
      const stats = upsertClaudeHooks(root, scope, resolveHookRunner(), wired);
      hooksChanged += stats.added + stats.updated + stats.removed + stats.deduped;
    }
  }

  log('');
  if (outdatedCount === 0) {
    const hooksNote = hooksChanged > 0 ? ` (hook wiring refreshed: ${hooksChanged} change${hooksChanged === 1 ? '' : 's'})` : '';
    log(`  ${c.green('✓')} every installed skill is already at the shipped version${hooksNote}.`);
  } else if (dryRun) {
    const plural = outdatedCount === 1 ? '' : 's';
    log(`  ${c.yellow('!')} ${outdatedCount} skill install${plural} outdated — run \`lorekit update\` to apply.`);
  } else {
    const plural = outdatedCount === 1 ? '' : 's';
    const removedNote = filesRemoved > 0 ? `, ${filesRemoved} removed` : '';
    log(`  ${c.green('✓')} refreshed ${outdatedCount} skill install${plural} (${filesWritten} file(s) written${removedNote}).`);
  }
  log('');

  return {
    // Non-zero only for a `--check` run that found drift — a real run always
    // finishes at 0 (it just fixed whatever it found), matching `doctor`'s own
    // deliberate warn-never-fail posture. This is what lets `--check` gate a
    // CI step or pre-commit hook on "everything is current" instead of only
    // ever reporting drift for a human to notice.
    exitCode: dryRun && outdatedCount > 0 ? 1 : 0,
    'lorekit.cli.update.scopes': scopes.length,
    'lorekit.cli.update.outdated': outdatedCount,
    'lorekit.cli.update.check': dryRun,
  };
}
