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
// re-copies (force) every skill into whichever scope(s) already have an
// install — reusing `copyDir`, the exact same skill-copy path `install` uses,
// so the two can never drift on what "installing a skill" means — and
// refreshes that scope's hook command string via `upsertClaudeHooks`, the
// same call `install --force` makes. That refresh is deliberately in scope:
// a stale `npx -y @lorekit/cli@1.2.3 hook …` pin or an old runner path is the
// same class of drift this command exists to fix, the call is idempotent
// (it only rewrites the command string, never the wired event set), and
// skipping it would leave `update` unable to repair the one other thing an
// install can go stale on. `--project` / `--global` narrow to one scope;
// with neither, every scope that currently has an existing skill install is
// refreshed — `update` never CREATES a fresh install, that stays `install`'s
// job.
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
// to exactly one; with neither, every scope holding at least one installed
// skill (any state other than `not-installed`) is refreshed.
function targetScopes(args, results) {
  if (args.project) return ['project'];
  if (args.global) return ['global'];
  return SKILL_SCOPES.filter((scope) => results.some((r) => r.scope === scope && r.state !== 'not-installed'));
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
      if (dryRun) {
        status('warn', label, `${before} → ${after} available — run \`lorekit update\` to refresh`);
        continue;
      }

      const dest = skillInstallDir(root, scope, skill.name);
      const written = copyDir(skill.source, dest, { force: true });
      filesWritten += written;
      status('pass', label, `${before} → ${after} (${written} file(s) written)`);
    }
  }

  // Hook command strings — refreshed for real, never on a dry run. Only a
  // scope that already has hooks wired has anything to refresh; a scope with
  // none stays untouched (matching `install`'s own "nothing to wire" no-op).
  if (!dryRun) {
    for (const scope of scopes) {
      const wired = installedHookEvents(root, scope);
      if (wired.length > 0) upsertClaudeHooks(root, scope, resolveHookRunner(), wired);
    }
  }

  log('');
  if (outdatedCount === 0) {
    log(`  ${c.green('✓')} every installed skill is already at the shipped version.`);
  } else if (dryRun) {
    const plural = outdatedCount === 1 ? '' : 's';
    log(`  ${c.yellow('!')} ${outdatedCount} skill install${plural} outdated — run \`lorekit update\` to apply.`);
  } else {
    const plural = outdatedCount === 1 ? '' : 's';
    log(`  ${c.green('✓')} refreshed ${outdatedCount} skill install${plural} (${filesWritten} file(s) written).`);
  }
  log('');

  return {
    exitCode: 0,
    'lorekit.cli.update.scopes': scopes.length,
    'lorekit.cli.update.outdated': outdatedCount,
    'lorekit.cli.update.check': dryRun,
  };
}
