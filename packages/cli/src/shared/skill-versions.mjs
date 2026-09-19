// Offline "installed vs shipped" skill version check.
//
// `lorekit install` copies each skill's SKILL.md verbatim and stamps no version
// anywhere else, so a skill installed at an old version has reported a healthy
// `doctor` PASS forever with no signal to update. The version data already
// exists: every skill's `SKILL.md` frontmatter carries `metadata.version`
// (e.g. `'1.0.0'`), and the shipped skill source travels in the SAME npm
// tarball as the running CLI (`SKILLS[].source` in `./config.mjs`) — so
// comparing "what's on disk" against "what this CLI ships" needs zero network
// calls and no server round-trip. `doctor` (per-scope reporting) and
// `lorekit update` (the refresh command) and the SessionStart drift nudge
// (`../core/update-notify.mjs`) all read through this one module so the three
// surfaces can't disagree about what counts as outdated.
//
// Dependency-free `.mjs`, like the other `shared/*.mjs` pure modules — no npm
// imports beyond node builtins.
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS, skillInstallDir } from './config.mjs';

/**
 * Pull the YAML frontmatter block out of a SKILL.md body — the text between
 * the first `---` line and the next one. `null` when there is no such block
 * (not a SKILL.md-shaped file, or a corrupt/truncated one).
 */
export function extractFrontmatter(markdown) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(typeof markdown === 'string' ? markdown : '');
  return m ? m[1] : null;
}

/**
 * Parse `metadata.version` out of a SKILL.md's frontmatter.
 *
 * Deliberately minimal: every SKILL.md this CLI ships has exactly one
 * `version:` line (nested under `metadata:`), so a plain line match — robust
 * to single/double quotes and a trailing comment — is enough without pulling
 * in a YAML parser this zero-dep package does not otherwise need. Returns
 * `null` when the frontmatter is absent or carries no `version:` line at all
 * (a legacy skill file predating the version stamp).
 */
export function parseSkillVersion(markdown) {
  const frontmatter = extractFrontmatter(markdown);
  if (!frontmatter) return null;
  const m = /^[ \t]*version:[ \t]*(['"]?)([^'"\n#]+?)\1[ \t]*(?:#.*)?$/m.exec(frontmatter);
  if (!m) return null;
  const version = m[2].trim();
  return version || null;
}

// Read + parse a SKILL.md's version, or `null` for anything that isn't a
// readable, parseable file — an absent path, a permissions error, and a file
// with no `version:` line all collapse to the same "unknown" signal.
function readVersion(skillMdPath) {
  try {
    return parseSkillVersion(fs.readFileSync(skillMdPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Dependency-free semver-ish compare of two dotted-numeric version strings.
 *
 * Returns `-1` / `0` / `1` the usual way, or `null` when either input is not a
 * usable version string (missing, empty, or containing a non-numeric segment —
 * pre-release/build metadata like `1.0.0-beta` is intentionally out of scope,
 * since every shipped SKILL.md version is a plain `x.y.z`). `null` reads as
 * "cannot compare", which callers treat as `unknown` rather than guessing a
 * direction.
 */
export function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.trim() || !b.trim()) return null;
  const toParts = (v) => v.trim().split('.').map((seg) => Number(seg));
  const pa = toParts(a);
  const pb = toParts(b);
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** The scopes a skill can be installed in — matches `skillInstallDir`'s. */
export const SKILL_SCOPES = ['project', 'global'];

/**
 * Classify one (skill, scope) pair against the version this CLI ships.
 *
 * `state`:
 *   - `not-installed` — no SKILL.md at that scope.
 *   - `current`       — installed version >= shipped version.
 *   - `outdated`       — installed version < shipped version.
 *   - `unknown`       — a SKILL.md exists but a version could not be
 *                        resolved on one side (an unparseable/legacy
 *                        installed file, or — in practice never — an
 *                        unparseable shipped one), so no direction can be
 *                        asserted.
 */
function classify(installedPath, shipped) {
  const installedExists = fs.existsSync(installedPath);
  if (!installedExists) {
    return { installed: null, state: 'not-installed' };
  }
  const installed = readVersion(installedPath);
  if (installed == null || shipped == null) {
    return { installed, state: 'unknown' };
  }
  const cmp = compareVersions(installed, shipped);
  if (cmp === null) return { installed, state: 'unknown' };
  return { installed, state: cmp < 0 ? 'outdated' : 'current' };
}

/**
 * Check every skill in `skills` (default: the CLI's own `SKILLS` list) at
 * every scope, comparing the INSTALLED `SKILL.md`'s `metadata.version`
 * against the SHIPPED source's. Pure filesystem reads — no network, no store.
 *
 * Returns one row per (skill, scope):
 *   `{ name, scope, installedPath, installed, shipped, state }`
 */
export function checkSkillVersions(root, { skills = SKILLS } = {}) {
  const results = [];
  for (const skill of skills) {
    const shipped = readVersion(path.join(skill.source, 'SKILL.md'));
    for (const scope of SKILL_SCOPES) {
      const installedPath = path.join(skillInstallDir(root, scope, skill.name), 'SKILL.md');
      const { installed, state } = classify(installedPath, shipped);
      results.push({ name: skill.name, scope, installedPath, installed, shipped, state });
    }
  }
  return results;
}

/**
 * The subset of `checkSkillVersions` results that need an update — `outdated`
 * or `unknown` (a legacy install with no readable version is exactly the case
 * `lorekit update` exists to repair, since re-copying stamps a fresh one).
 * `not-installed` and `current` are excluded — neither one is drift to act on.
 */
export function skillsNeedingUpdate(results) {
  return (Array.isArray(results) ? results : []).filter(
    (r) => r && (r.state === 'outdated' || r.state === 'unknown'),
  );
}
