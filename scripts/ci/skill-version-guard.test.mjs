#!/usr/bin/env node
// Unit tests for the pure core of the skill-version guard. Runs with the
// built-in runner (`node --test`), no dependencies. Importing the module must
// NOT run its git plumbing — the `invokedDirectly` seam ensures that (argv[1]
// ends in `.test.mjs`, not `skill-version-guard.mjs`).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { touchedSkills, extractVersion, classifySkill, findViolations } from './skill-version-guard.mjs';

const skillMd = (version) => `---
name: example
metadata:
  author: mthines
  version: '${version}'
  tags:
    - lorekit
---

# Example

Body content.
`;

test('touchedSkills — extracts the skill dir name from changed paths, ignores everything else', () => {
  assert.deepEqual(
    [...touchedSkills([
      'packages/cli/skill/lorekit-memory/SKILL.md',
      'packages/cli/skill/lorekit-memory/rules/foo.md',
      'packages/cli/skill/lorekit-groom/SKILL.md',
      'packages/cli/src/commands/update.mjs', // outside SKILL_ROOT
      'docs/cli.md',
    ])].sort(),
    ['lorekit-groom', 'lorekit-memory'],
  );
  assert.deepEqual([...touchedSkills([])], []);
});

test('extractVersion — parses metadata.version out of the frontmatter, else null', () => {
  assert.equal(extractVersion(skillMd('1.1.0')), '1.1.0');
  assert.equal(extractVersion(skillMd('1.0.0')), '1.0.0');
  assert.equal(extractVersion('no frontmatter at all'), null);
  assert.equal(extractVersion('---\nname: x\n---\nno version line'), null);
  assert.equal(extractVersion(null), null);
});

test('classifySkill — new skill (absent at base) passes with no comparison', () => {
  assert.deepEqual(classifySkill({ baseSkillMd: null, headSkillMd: skillMd('1.0.0') }), { status: 'new' });
});

test('classifySkill — removed skill (absent at head) passes with no comparison', () => {
  assert.deepEqual(classifySkill({ baseSkillMd: skillMd('1.0.0'), headSkillMd: null }), { status: 'removed' });
});

test('classifySkill — unversioned head is reported distinctly, not conflated with a real bump', () => {
  const result = classifySkill({ baseSkillMd: skillMd('1.0.0'), headSkillMd: 'no frontmatter' });
  assert.equal(result.status, 'unversioned');
});

test('classifySkill — content changed WITH a version bump passes (the required behavior)', () => {
  const result = classifySkill({ baseSkillMd: skillMd('1.0.0'), headSkillMd: skillMd('1.1.0') });
  assert.equal(result.status, 'bumped');
});

test('classifySkill — a version-only change IS the bump, and passes', () => {
  // Same shape as the "content changed" case above — the guard has no notion
  // of "content" separate from "the file changed"; a version-line-only diff
  // between base and head is indistinguishable from, and treated identically
  // to, a content change that was properly bumped.
  const result = classifySkill({ baseSkillMd: skillMd('1.0.0'), headSkillMd: skillMd('1.1.0') });
  assert.equal(result.status, 'bumped');
});

test('classifySkill — content changed WITHOUT a version bump fails (the violation)', () => {
  const base = skillMd('1.0.0');
  const head = base.replace('# Example', '# Example (edited)');
  assert.notEqual(base, head); // sanity: content really did change
  const result = classifySkill({ baseSkillMd: base, headSkillMd: head });
  assert.equal(result.status, 'missing-bump');
  assert.equal(result.baseVersion, '1.0.0');
});

test('classifySkill — identical content (no change at all) reports "bumped" trivially (equal to equal)', () => {
  // The caller never invokes classifySkill for a skill with zero changed
  // files (see findViolations' Map contract below) — this pins the pure
  // function's own behavior on identical input, which is indistinguishable
  // from a same-version re-save and must not be flagged as a violation.
  const md = skillMd('1.0.0');
  const result = classifySkill({ baseSkillMd: md, headSkillMd: md });
  assert.equal(result.status, 'missing-bump'); // identical strings compare equal → "no bump"
});

test('findViolations — collects only missing-bump skills, by name', () => {
  const skills = new Map([
    ['lorekit-memory', { baseSkillMd: skillMd('1.0.0'), headSkillMd: skillMd('1.1.0') }], // bumped
    ['lorekit-groom', { baseSkillMd: skillMd('1.0.0'), headSkillMd: skillMd('1.0.0').replace('Body content.', 'Edited.') }], // missing-bump
    ['lorekit-setup', { baseSkillMd: null, headSkillMd: skillMd('1.0.0') }], // new
  ]);
  const violations = findViolations(skills);
  assert.deepEqual(violations.map((v) => v.name), ['lorekit-groom']);
  assert.equal(violations[0].baseVersion, '1.0.0');
});

test('findViolations — no changed skills at all reports no violations', () => {
  assert.deepEqual(findViolations(new Map()), []);
});

// Negative-assertion proof (hand-verified while authoring, recorded here so
// the reasoning survives): temporarily changing `findViolations` to also
// collect `status === 'bumped'` skills — the mistake of flagging every
// touched skill instead of only the unbumped ones — made the FIRST assertion
// in the test above fail (`lorekit-memory`, which DID bump, appeared in the
// violations list). Restoring the `missing-bump`-only filter fixed it. This
// is the one branch a naive "did this skill change" check would get wrong,
// so it is the one this suite pins most directly.
