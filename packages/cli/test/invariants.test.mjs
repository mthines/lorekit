// `lorekit invariants candidates` — the compile pipeline's candidate scan.
// Integration tests spawn the real binary against a temp local store, the
// same pattern `dedupe.test.mjs` uses (and this command reuses dedupe's own
// clustering), so the fixtures deliberately mirror that file's shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function entry({ scope, key, value, seenCount = 1, tags = [] }) {
  const fm = {
    scope,
    key,
    tags,
    source_agent: 'aw',
    trigger: 'manual',
    seen_count: seenCount,
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    archived_at: null,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${value}\n`;
}

function baseEnv(home, extraEnv) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    LOREKIT_HOME: home,
    LOREKIT_TELEMETRY: '0',
  };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  Object.assign(env, extraEnv);
  return env;
}

function runCandidates(root, home, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'invariants', 'candidates', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
  });
}

// A project with three near-duplicate pairs:
//   - "recurring-*": summed seen_count 4 (2+2), across two scopes → a candidate.
//   - "rare-*": summed seen_count 2 (1+1), no meta status → NOT a candidate.
//   - "structural-*": summed seen_count 2, but one member declares
//     status=structural in its meta comment → a candidate despite low seen_count.
function seedProject() {
  const root = tmp('lk-invariants-proj-');
  const home = tmp('lk-invariants-home-');
  const projectName = path.basename(root).toLowerCase();
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.mkdirSync(path.join(store, 'project', projectName), { recursive: true });
  const write = (rel, e) => fs.writeFileSync(path.join(store, rel), entry(e));

  write('global/recurring-a.md', {
    scope: 'global',
    key: 'recurring-a',
    seenCount: 2,
    value: 'the retry loop keeps hammering the same endpoint on every failure',
  });
  write(`project/${projectName}/recurring-b.md`, {
    scope: `project::${projectName}`,
    key: 'recurring-b',
    seenCount: 2,
    value: 'the retry loop keeps hammering the same endpoint on every failure again',
  });

  write('global/rare-a.md', {
    scope: 'global',
    key: 'rare-a',
    seenCount: 1,
    value: 'a config file needs a trailing newline or the linter complains',
  });
  write('global/rare-b.md', {
    scope: 'global',
    key: 'rare-b',
    seenCount: 1,
    value: 'a config file needs a trailing newline or the linter complains too',
  });

  // A meta comment's own syntax tokens ("meta", "status", …) count toward the
  // Jaccard denominator, so the shared sentence has to be long enough that a
  // lean meta prefix doesn't dilute similarity below dedupe's 0.8 threshold —
  // the two bodies below are otherwise IDENTICAL (14 shared words) with only
  // structural-a carrying the 3-token `<!-- meta: status=structural -->`
  // prefix, which nets ~0.82 similarity.
  const structuralSentence =
    'the migration script always needs a paired rollback test written and checked before merge';
  write('global/structural-a.md', {
    scope: 'global',
    key: 'structural-a',
    seenCount: 1,
    value: `<!-- meta: status=structural -->\n${structuralSentence}`,
  });
  write('global/structural-b.md', {
    scope: 'global',
    key: 'structural-b',
    seenCount: 1,
    value: structuralSentence,
  });

  return { root, home, projectName };
}

test('candidates finds the high-recurrence cluster, skips the rare one', () => {
  const { root, home } = seedProject();
  const res = runCandidates(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const keys = out.offline.candidates.flatMap((c) => c.members.map((m) => m.key)).sort();
  assert.ok(keys.includes('recurring-a'), 'the high seen_count cluster must be a candidate');
  assert.ok(keys.includes('recurring-b'));
  assert.ok(!keys.includes('rare-a'), 'summed seen_count 2 < default min-seen-count 3 should not qualify');
  assert.ok(!keys.includes('rare-b'));
});

test('a non-"active" status qualifies a cluster regardless of seen_count', () => {
  const { root, home } = seedProject();
  const res = runCandidates(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const structural = out.offline.candidates.find((c) => c.members.some((m) => m.key === 'structural-a'));
  assert.ok(structural, 'the structural-status cluster must be a candidate despite low seen_count');
  const member = structural.members.find((m) => m.key === 'structural-a');
  assert.equal(member.meta.status, 'structural');
});

test('candidates are ranked by score (summed seen_count × distinct scopes) descending', () => {
  const { root, home } = seedProject();
  const res = runCandidates(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const scores = out.offline.candidates.map((c) => c.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepEqual(scores, sorted);
  // recurring spans 2 scopes (score 4*2=8) and beats structural's 1 scope (score 2*1=2).
  assert.equal(out.offline.candidates[0].members.some((m) => m.key.startsWith('recurring')), true);
});

test('--min-seen-count lowers the bar so the rare cluster also qualifies', () => {
  const { root, home } = seedProject();
  const res = runCandidates(root, home, ['--min-seen-count', '2', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const keys = out.offline.candidates.flatMap((c) => c.members.map((m) => m.key));
  assert.ok(keys.includes('rare-a'));
  assert.ok(keys.includes('rare-b'));
});

test('the rendered output lists every memory a candidate would collapse', () => {
  const { root, home } = seedProject();
  const res = runCandidates(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /candidate 1/);
  assert.match(res.stdout, /recurring-a/);
  assert.match(res.stdout, /recurring-b/);
  assert.match(res.stdout, /seen_count=2/);
  assert.match(res.stdout, /nothing here compiles or gates on its own/);
});

test('--scope narrows the scope considered', () => {
  const { root, home, projectName } = seedProject();
  const res = runCandidates(root, home, ['--scope', `project::${projectName}`, '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scopes, [`project::${projectName}`]);
  // recurring-a lives in global, so the cross-scope pair can't cluster from
  // this single scope alone.
  assert.equal(out.offline.candidates.length, 0);
});

test('LOREKIT_DENY=local suppresses offline candidates', () => {
  const { root, home } = seedProject();
  const res = runCandidates(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});

test('degrades an unconfigured remote to a note, never an error', () => {
  const { root, home } = seedProject();
  const res = runCandidates(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Remote/);
  assert.match(res.stdout, /unavailable/);
});

test('an empty store reports no candidates without error', () => {
  const root = tmp('lk-invariants-empty-proj-');
  const home = tmp('lk-invariants-empty-home-');
  fs.mkdirSync(path.join(root, '.lorekit', 'global'), { recursive: true });
  const res = runCandidates(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no compile candidates/);
});

test('an unknown subcommand is a usage error, not a crash', () => {
  const { root, home } = seedProject();
  const res = spawnSync(process.execPath, [BIN, 'invariants', 'bogus', '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, {}),
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage/);
});
