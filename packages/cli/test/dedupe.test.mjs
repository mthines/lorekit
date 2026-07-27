// `lorekit dedupe` — heuristic near-duplicate detection.
//
// Two layers of coverage:
//   • unit — the pure heuristic (`tokenize`, `similarity`, `clusterDuplicates`,
//     `parseThreshold`): identical, near-identical, disjoint, the threshold
//     boundary, empties, transitive clustering, and threshold parsing;
//   • integration — the real binary spawned in a temp project with a duplicate
//     pair and a distinct lesson, asserting the cluster, `--threshold`, `--json`,
//     `--scope`, deny suppression, and graceful remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenize, similarity, clusterDuplicates } from '../src/lessons-view.mjs';
import { parseThreshold, repoThreshold } from '../src/dedupe.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: tokenize + similarity ───────────────────────────────────────────────

test('tokenize lowercases and splits on non-alphanumerics', () => {
  assert.deepEqual([...tokenize('The Cache, is FLAKY!')].sort(), ['cache', 'flaky', 'is', 'the']);
  assert.deepEqual([...tokenize('')], []);
});

test('similarity: identical strings score 1, disjoint score 0', () => {
  assert.equal(similarity('the cache is flaky', 'the cache is flaky'), 1);
  assert.equal(similarity('alpha beta gamma', 'delta epsilon zeta'), 0);
});

test('similarity: near-identical scores high but below 1', () => {
  const s = similarity('the cache is flaky on ci', 'the cache is flaky on ci sometimes');
  assert.ok(s > 0.7 && s < 1, `expected high-but-partial, got ${s}`);
});

test('similarity: two empty bodies are identical (1); one empty is disjoint (0)', () => {
  assert.equal(similarity('', ''), 1);
  assert.equal(similarity('has words', ''), 0);
});

test('similarity accepts pre-computed token Sets', () => {
  assert.equal(similarity(tokenize('a b c'), tokenize('a b c')), 1);
});

// ── unit: clusterDuplicates ───────────────────────────────────────────────────

test('clusterDuplicates groups an identical pair, ignores the singleton', () => {
  const clusters = clusterDuplicates(
    [
      { scope: 'global', key: 'a', value: 'the cache is flaky on windows ci' },
      { scope: 'repo::x/y', key: 'b', value: 'the cache is flaky on windows ci' },
      { scope: 'global', key: 'c', value: 'totally unrelated content entirely' },
    ],
    0.8,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 2);
  assert.equal(clusters[0].minSimilarity, 1);
  const keys = clusters[0].members.map((m) => m.key).sort();
  assert.deepEqual(keys, ['a', 'b']);
});

test('clusterDuplicates: disjoint entries produce no clusters', () => {
  const clusters = clusterDuplicates(
    [
      { scope: 'global', key: 'a', value: 'alpha beta gamma' },
      { scope: 'global', key: 'b', value: 'delta epsilon zeta' },
    ],
    0.5,
  );
  assert.deepEqual(clusters, []);
});

test('clusterDuplicates: the threshold boundary is inclusive (>=)', () => {
  // Two 4-token sets sharing 3 tokens → Jaccard = 3/5 = 0.6.
  const entries = [
    { scope: 'g', key: 'a', value: 'one two three four' },
    { scope: 'g', key: 'b', value: 'one two three five' },
  ];
  assert.equal(similarity(entries[0].value, entries[1].value), 0.6);
  assert.equal(clusterDuplicates(entries, 0.6).length, 1); // exactly at threshold → clusters
  assert.equal(clusterDuplicates(entries, 0.61).length, 0); // just above → no cluster
});

test('clusterDuplicates: transitive linking merges a chain into one cluster', () => {
  const entries = [
    { scope: 'g', key: 'a', value: 'one two three four' },
    { scope: 'g', key: 'b', value: 'one two three five' }, // ~a
    { scope: 'g', key: 'c', value: 'one two three six' }, // ~b (and ~a)
  ];
  const clusters = clusterDuplicates(entries, 0.6);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 3);
});

test('clusterDuplicates on empty input is empty', () => {
  assert.deepEqual(clusterDuplicates([], 0.8), []);
  assert.deepEqual(clusterDuplicates([{ scope: 'g', key: 'a', value: 'lonely' }], 0.8), []);
});

// ── unit: parseThreshold ──────────────────────────────────────────────────────

test('parseThreshold clamps, defaults, and rejects garbage', () => {
  assert.equal(parseThreshold(undefined), 0.8);
  assert.equal(parseThreshold(true), 0.8); // bare `--threshold` with no value
  assert.equal(parseThreshold('0.6'), 0.6);
  assert.equal(parseThreshold('2'), 1); // clamped high
  assert.equal(parseThreshold('-1'), 0); // clamped low
  assert.equal(parseThreshold('nope'), 0.8); // unparseable → default
});

// ── integration fixtures ──────────────────────────────────────────────────────

function entry({ scope, key, value, tags = [] }) {
  const fm = {
    scope,
    key,
    tags,
    source_agent: 'aw',
    trigger: 'manual',
    created: '2026-07-20T10:00:00.000Z',
    updated: '2026-07-20T10:00:00.000Z',
    archived_at: null,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${value}\n`;
}

// A project (project + global scopes) with a near-duplicate pair spanning the two
// scopes and one clearly-distinct lesson.
function seedProject() {
  const root = tmp('lk-dedupe-proj-');
  const home = tmp('lk-dedupe-home-');
  const projectName = path.basename(root).toLowerCase();
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.mkdirSync(path.join(store, 'project', projectName), { recursive: true });
  const write = (rel, e) => fs.writeFileSync(path.join(store, rel), entry(e));
  write('global/a.md', { scope: 'global', key: 'cache-a', value: 'the build cache is flaky on windows ci runners' });
  write(`project/${projectName}/b.md`, {
    scope: `project::${projectName}`,
    key: 'cache-b',
    value: 'the build cache is flaky on windows ci runners sometimes',
  });
  write('global/c.md', { scope: 'global', key: 'unrelated', value: 'prefer early returns to reduce nesting depth' });
  return { root, home, projectName };
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

function runDedupe(root, home, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'dedupe', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
  });
}

// ── integration ───────────────────────────────────────────────────────────────

test('dedupe clusters the near-duplicate pair across scopes (exit 0)', () => {
  const { root, home } = seedProject();
  const res = runDedupe(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /duplicate cluster/);
  assert.match(res.stdout, /cache-a/);
  assert.match(res.stdout, /cache-b/);
  assert.doesNotMatch(res.stdout, /unrelated/); // the distinct lesson is not clustered
});

test('dedupe --json lists the cluster members and similarity signal', () => {
  const { root, home, projectName } = seedProject();
  const res = runDedupe(root, home, ['--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.threshold, 0.8);
  assert.equal(out.offline.clusters.length, 1);
  const members = out.offline.clusters[0].members.map((m) => `${m.scope}::${m.key}`).sort();
  assert.deepEqual(members, ['global::cache-a', `project::${projectName}::cache-b`]);
  assert.ok(out.offline.clusters[0].minSimilarity >= 0.8);
});

test('dedupe --threshold 1 requires exact token equality (no cluster for near-dupes)', () => {
  const { root, home } = seedProject();
  const res = runDedupe(root, home, ['--threshold', '1', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.threshold, 1);
  assert.equal(out.offline.clusters.length, 0); // the pair differs by one token
});

test('dedupe --scope narrows the scope considered (one scope → no cross-scope pair)', () => {
  const { root, home } = seedProject();
  const res = runDedupe(root, home, ['--scope', 'global', '--json']);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scopes, ['global']);
  assert.equal(out.offline.clusters.length, 0); // cache-a and unrelated are disjoint
});

test('LOREKIT_DENY=local suppresses offline dedupe', () => {
  const { root, home } = seedProject();
  const res = runDedupe(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
});

test('dedupe degrades an unconfigured remote to a note, never an error', () => {
  const { root, home } = seedProject();
  const res = runDedupe(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Remote/);
  assert.match(res.stdout, /unavailable/);
});

// ── dedupe.threshold in .lorekit.json ─────────────────────────────────────────

test('repoThreshold reads dedupe.threshold from .lorekit.json', () => {
  const root = tmp('lk-rth-');
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ 'dedupe.threshold': 0.6 }));
  assert.equal(repoThreshold(root), 0.6);
});

test('repoThreshold returns undefined when .lorekit.json is absent', () => {
  const root = tmp('lk-rth-');
  assert.equal(repoThreshold(root), undefined);
});

test('repoThreshold returns undefined when dedupe.threshold is not set', () => {
  const root = tmp('lk-rth-');
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ mode: 'local' }));
  assert.equal(repoThreshold(root), undefined);
});

test('dedupe.threshold from .lorekit.json is used when no --threshold flag', () => {
  // Seed a project with two near-duplicates and threshold 0.0 (always cluster).
  const root = tmp('lk-dth-');
  const home = tmp('lk-dth-home-');
  const store = path.join(root, '.lorekit');
  const gScope = path.join(store, 'global');
  fs.mkdirSync(gScope, { recursive: true });
  const md = (key, val) =>
    `---\nscope: global\nkey: ${key}\n---\n${val}`;
  fs.writeFileSync(path.join(gScope, 'alpha.md'), md('alpha', 'totally different lesson'));
  fs.writeFileSync(path.join(gScope, 'beta.md'), md('beta', 'totally different lesson here too'));
  // threshold 0.0 → everything clusters
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ 'dedupe.threshold': 0.0 }));
  const res = spawnSync('node', [BIN, 'dedupe', '--dir', root, '--store', store], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, LOREKIT_HOME: home, LOREKIT_DENY: 'remote' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Cluster/i, 'expected a cluster at threshold 0');
});
