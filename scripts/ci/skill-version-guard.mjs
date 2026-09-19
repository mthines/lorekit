#!/usr/bin/env node
/**
 * Skill-version guard (PR-time).
 *
 * Fails when a pull request changes ANY file inside a shipped skill directory
 * (`packages/cli/skill/<name>/**`) without also bumping that skill's
 * `metadata.version` in its `SKILL.md` frontmatter.
 *
 * WHY THIS EXISTS. `lorekit update` / `doctor` / the SessionStart drift nudge
 * (see `packages/cli/src/shared/skill-versions.mjs`) all decide "is this
 * install outdated" by comparing the installed `SKILL.md`'s stamped version
 * against the shipped one. That comparison is only as honest as the stamp: all
 * three shipped skills sat at `1.0.0` through four content-changing PRs before
 * this guard existed, so `lorekit update` was comparing a number that never
 * moved — every installed copy looked perpetually current no matter how far it
 * had drifted. This guard makes the drift-detection feature's own data
 * trustworthy, the same way `check-migration-order.mjs` makes the deploy
 * pipeline's migration-ordering assumption trustworthy: catch the omission at
 * review time, in a unit-tested module, rather than downstream where nothing
 * would ever fail loudly.
 *
 * SCOPE. Deliberately keyed off the SOURCE skill directories
 * (`packages/cli/skill/*`) only. The Claude-plugin-vendored copies under
 * `plugins/lorekit-claude/skills/*` are a generated mirror of that source
 * (`scripts/codegen/sync-plugin-skill.mjs`), already guarded byte-for-byte by
 * that script's own `--check` mode (run in `scripts/smoke/smoke-plugin.sh`,
 * gated by the `plugin` CI job). Checking the vendored copies here too would
 * just be a second guard for the same fact the sync `--check` already proves;
 * this guard and that one compose instead of overlapping.
 *
 * WHAT COUNTS AS A VIOLATION. Any file under a skill's directory changed
 * (added, modified, or deleted) between `base` and `head`, AND the skill's
 * `SKILL.md` `metadata.version` string is IDENTICAL at both refs. A change to
 * ONLY the version line is exactly the bump this guard wants, so it passes. A
 * brand-new skill directory (absent at `base`) has nothing to compare against
 * and passes. A skill directory removed entirely by `head` passes too — there
 * is no shipped version left to have drifted from.
 *
 *   node scripts/ci/skill-version-guard.mjs <base-ref> [head-ref]
 *   node scripts/ci/skill-version-guard.mjs origin/main
 *
 * `head-ref` defaults to `HEAD`. Exit 0 = every changed skill bumped its
 * version (or no skill changed); exit 1 = at least one did not.
 */

import { execFileSync } from 'node:child_process';

export const SKILL_ROOT = 'packages/cli/skill';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** Read a file's content at a given ref, or `null` when it does not exist there. */
function readAtRef(ref, filePath, gitImpl = git) {
  try {
    return gitImpl(['show', `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * `packages/cli/skill/lorekit-memory/SKILL.md` → `lorekit-memory`.
 * Any path outside `SKILL_ROOT` is ignored (returns `undefined` via the regex
 * not matching, filtered by the caller).
 */
const SKILL_DIR_RE = new RegExp(`^${SKILL_ROOT}/([^/]+)/`);

/** The set of skill names touched by any of `changedFiles`. */
export function touchedSkills(changedFiles) {
  const names = new Set();
  for (const f of changedFiles) {
    const m = SKILL_DIR_RE.exec(f);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Pull `metadata.version` out of a SKILL.md body's YAML frontmatter.
 *
 * Deliberately the same minimal, YAML-parser-free approach as
 * `packages/cli/src/shared/skill-versions.mjs`'s `parseSkillVersion` —
 * duplicated rather than imported because `scripts/ci/**` stays dependency-free
 * of the workspace packages (same convention as every other guard in this
 * directory). Both copies target the identical `version: 'x.y.z'` shape every
 * shipped `SKILL.md` uses, so drift between them is unlikely and low-stakes:
 * this guard only compares the extracted string for EQUALITY, never its
 * semver ordering, so a difference in how liberally the two regexes parse
 * edge-case formatting cannot silently pass a real violation.
 */
export function extractVersion(markdown) {
  if (typeof markdown !== 'string') return null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!fm) return null;
  const m = /^[ \t]*version:[ \t]*(['"]?)([^'"\n#]+?)\1[ \t]*(?:#.*)?$/m.exec(fm[1]);
  if (!m) return null;
  const version = m[2].trim();
  return version || null;
}

/**
 * Classify one touched skill against its `SKILL.md` at `base` vs `head`.
 *
 * `status`:
 *   - `new`          — no `SKILL.md` at `base` (skill did not exist yet).
 *   - `removed`      — no `SKILL.md` at `head` (skill was deleted).
 *   - `unversioned`  — `SKILL.md` exists at `head` but carries no parseable
 *                       version (a pre-existing gap this guard does not
 *                       introduce a new way to fail on).
 *   - `bumped`       — the version string differs between `base` and `head`.
 *   - `missing-bump` — content changed but the version string is identical —
 *                       the violation this guard exists to catch.
 */
export function classifySkill({ baseSkillMd, headSkillMd }) {
  if (baseSkillMd == null) return { status: 'new' };
  if (headSkillMd == null) return { status: 'removed' };
  const baseVersion = extractVersion(baseSkillMd);
  const headVersion = extractVersion(headSkillMd);
  if (headVersion == null) return { status: 'unversioned', baseVersion, headVersion };
  if (baseVersion !== headVersion) return { status: 'bumped', baseVersion, headVersion };
  return { status: 'missing-bump', baseVersion, headVersion };
}

/**
 * The pure core: given every touched skill's before/after `SKILL.md` content,
 * return the ones that changed content without bumping their version.
 * `skills` is `Map<name, { baseSkillMd, headSkillMd }>`.
 */
export function findViolations(skills) {
  const violations = [];
  for (const [name, content] of skills) {
    const result = classifySkill(content);
    if (result.status === 'missing-bump') violations.push({ name, ...result });
  }
  return violations;
}

// Run the git plumbing only when invoked as a script (not when imported by a test).
const invokedDirectly = process.argv[1] && /skill-version-guard\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  const base = process.argv[2] || process.env.SKILL_VERSION_GUARD_BASE;
  const head = process.argv[3] || 'HEAD';
  if (!base) {
    process.stderr.write('usage: skill-version-guard.mjs <base-ref> [head-ref]  (or set SKILL_VERSION_GUARD_BASE)\n');
    process.exit(2);
  }

  const changed = git(['diff', '--name-only', `${base}...${head}`, '--', SKILL_ROOT])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const names = touchedSkills(changed);
  if (names.size === 0) {
    process.stdout.write('skill-version-guard: no shipped skill directory changed — ok\n');
    process.exit(0);
  }

  const skills = new Map();
  for (const name of names) {
    const skillMdPath = `${SKILL_ROOT}/${name}/SKILL.md`;
    skills.set(name, {
      baseSkillMd: readAtRef(base, skillMdPath),
      headSkillMd: readAtRef(head, skillMdPath),
    });
  }

  const violations = findViolations(skills);
  if (violations.length === 0) {
    process.stdout.write(
      `skill-version-guard: ${names.size} skill(s) touched, every one bumped \`metadata.version\` — ok\n`,
    );
    process.exit(0);
  }

  process.stderr.write('::error::Skill content changed without a version bump:\n');
  for (const { name, baseVersion } of violations) {
    process.stderr.write(
      `  - ${SKILL_ROOT}/${name}/SKILL.md — still \`version: '${baseVersion}'\`\n`,
    );
  }
  process.stderr.write(
    'Bump `metadata.version` in the changed skill(s)\' SKILL.md — drift detection ' +
      '(`doctor` / `lorekit update` / the SessionStart nudge) compares this stamp, so an ' +
      'unbumped version makes the change invisible to every installed copy.\n',
  );
  process.exit(1);
}
