// Pure unit tests for `shared/skill-versions.mjs`: the frontmatter version
// parser, the dependency-free semver-ish compare, and the drift classifier
// `checkSkillVersions`/`skillsNeedingUpdate` build on top of both.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractFrontmatter,
  parseSkillVersion,
  compareVersions,
  checkSkillVersions,
  skillsNeedingUpdate,
  SKILL_SCOPES,
} from '../src/shared/skill-versions.mjs';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Write a fake skill's SKILL.md, with or without a version stamp.
function writeSkillMd(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const body =
    version == null
      ? `---\nname: fake-skill\ndescription: a fake skill\n---\nbody\n`
      : `---\nname: fake-skill\nmetadata:\n  author: test\n  version: '${version}'\n---\nbody\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

// Run `fn` with HOME/USERPROFILE pinned to `home`, restoring afterward — the
// global scope resolves through `homeDir()`, which reads the env at call
// time, so a test that checks the global scope must isolate it from whatever
// is actually installed on the machine running the suite.
function withHome(home, fn) {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

describe('extractFrontmatter', () => {
  test('pulls the block between the two --- fences', () => {
    assert.equal(extractFrontmatter('---\nname: x\n---\nbody'), 'name: x');
  });

  test('null with no frontmatter fence', () => {
    assert.equal(extractFrontmatter('just a markdown file'), null);
  });

  test('null for non-string input', () => {
    assert.equal(extractFrontmatter(null), null);
    assert.equal(extractFrontmatter(undefined), null);
  });
});

describe('parseSkillVersion', () => {
  test('reads a single-quoted version', () => {
    assert.equal(parseSkillVersion(`---\nmetadata:\n  version: '1.2.0'\n---\n`), '1.2.0');
  });

  test('reads a double-quoted version with a trailing comment', () => {
    assert.equal(parseSkillVersion(`---\nmetadata:\n  version: "2.0.0" # bumped\n---\n`), '2.0.0');
  });

  test('reads an unquoted version', () => {
    assert.equal(parseSkillVersion(`---\nmetadata:\n  version: 3.1.4\n---\n`), '3.1.4');
  });

  test('nested under other metadata keys', () => {
    const md = `---\nname: x\nmetadata:\n  author: mthines\n  version: '1.0.0'\n---\nbody`;
    assert.equal(parseSkillVersion(md), '1.0.0');
  });

  test('null when there is no frontmatter at all', () => {
    assert.equal(parseSkillVersion('no frontmatter here'), null);
  });

  test('null when frontmatter exists but carries no version line (legacy)', () => {
    assert.equal(parseSkillVersion(`---\nname: x\ndescription: y\n---\nbody`), null);
  });
});

describe('compareVersions', () => {
  test('equal versions compare 0', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  test('a lower version compares -1, a higher +1', () => {
    assert.equal(compareVersions('1.0.0', '1.2.0'), -1);
    assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  });

  // Proof this is a NUMERIC compare, not a lexical one: '1.9.0' vs '1.10.0'
  // sorts the WRONG way under a plain string compare ('9' > '1' lexically).
  // Verified this assertion fails without the fix: swapping the
  // implementation's `.split('.').map(Number)` compare for a bare `a < b`
  // string comparison makes this assertion fail (asserts -1, string compare
  // yields 1) — confirming the numeric split is load-bearing, not incidental.
  test('compares numerically per segment, not lexically', () => {
    assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  });

  test('a shorter version is padded with zeros', () => {
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.equal(compareVersions('1.2', '1.2.1'), -1);
  });

  test('null (unknown) for unparseable or missing input', () => {
    assert.equal(compareVersions('abc', '1.0.0'), null);
    assert.equal(compareVersions('1.0.0', 'abc'), null);
    assert.equal(compareVersions(null, '1.0.0'), null);
    assert.equal(compareVersions('1.0.0', undefined), null);
    assert.equal(compareVersions('', '1.0.0'), null);
  });
});

describe('checkSkillVersions', () => {
  test('classifies not-installed / current / outdated per scope', () => {
    const root = tmp('lk-skillver-root-');
    const home = tmp('lk-skillver-home-');
    const source = tmp('lk-skillver-src-');
    writeSkillMd(source, '2.0.0'); // the "shipped" version

    // project: behind the shipped version.
    writeSkillMd(path.join(root, '.claude', 'skills', 'fake-skill'), '1.0.0');
    // global: exactly current.
    writeSkillMd(path.join(home, '.claude', 'skills', 'fake-skill'), '2.0.0');

    const results = withHome(home, () =>
      checkSkillVersions(root, { skills: [{ name: 'fake-skill', source }] }),
    );
    assert.equal(results.length, SKILL_SCOPES.length);
    const byScope = Object.fromEntries(results.map((r) => [r.scope, r]));

    assert.equal(byScope.project.state, 'outdated');
    assert.equal(byScope.project.installed, '1.0.0');
    assert.equal(byScope.project.shipped, '2.0.0');

    assert.equal(byScope.global.state, 'current');
    assert.equal(byScope.global.installed, '2.0.0');
  });

  test('reports not-installed when no SKILL.md exists at that scope', () => {
    const root = tmp('lk-skillver-none-root-');
    const home = tmp('lk-skillver-none-home-'); // deliberately empty
    const source = tmp('lk-skillver-none-src-');
    writeSkillMd(source, '1.0.0');

    const results = withHome(home, () =>
      checkSkillVersions(root, { skills: [{ name: 'fake-skill', source }] }),
    );
    for (const r of results) {
      assert.equal(r.state, 'not-installed');
      assert.equal(r.installed, null);
    }
  });

  test('unknown when the installed file has no parseable version (legacy install)', () => {
    const root = tmp('lk-skillver-legacy-root-');
    const home = tmp('lk-skillver-legacy-home-');
    const source = tmp('lk-skillver-legacy-src-');
    writeSkillMd(source, '1.0.0');
    // Installed copy predates version stamping — frontmatter, no `version:`.
    writeSkillMd(path.join(root, '.claude', 'skills', 'fake-skill'), null);

    const results = withHome(home, () =>
      checkSkillVersions(root, { skills: [{ name: 'fake-skill', source }] }),
    );
    const project = results.find((r) => r.scope === 'project');
    assert.equal(project.state, 'unknown');
    assert.equal(project.installed, null);
  });
});

describe('skillsNeedingUpdate', () => {
  test('includes outdated and unknown, excludes current and not-installed', () => {
    const rows = [
      { name: 'a', scope: 'project', state: 'outdated', installed: '1.0.0', shipped: '2.0.0' },
      { name: 'b', scope: 'project', state: 'unknown', installed: null, shipped: '1.0.0' },
      { name: 'c', scope: 'project', state: 'current', installed: '1.0.0', shipped: '1.0.0' },
      { name: 'd', scope: 'global', state: 'not-installed', installed: null, shipped: '1.0.0' },
    ];
    const needing = skillsNeedingUpdate(rows).map((r) => r.name);
    assert.deepEqual(needing.sort(), ['a', 'b']);
  });

  // Negative-assertion proof: dropping the `r.state === 'unknown'` clause from
  // the implementation's filter (leaving only `outdated`) makes this fail,
  // since `b` above would then be excluded — verified by hand while authoring.
  test('empty for an all-current, all-not-installed set', () => {
    const rows = [
      { name: 'a', scope: 'project', state: 'current', installed: '1.0.0', shipped: '1.0.0' },
      { name: 'a', scope: 'global', state: 'not-installed', installed: null, shipped: '1.0.0' },
    ];
    assert.deepEqual(skillsNeedingUpdate(rows), []);
  });

  test('total: handles non-array input', () => {
    assert.deepEqual(skillsNeedingUpdate(null), []);
    assert.deepEqual(skillsNeedingUpdate(undefined), []);
  });
});
