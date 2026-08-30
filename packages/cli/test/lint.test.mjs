// `lorekit lint` — flag low-quality lessons across the applicable scopes.
//
// Two layers of coverage:
//   • unit — the pure rule predicates (`scopeIssue`, each `LINT_RULES` entry,
//     `lintEntry`, `lintGroups`): every rule firing AND not firing, plus mutual
//     exclusivity of empty-value vs short-value;
//   • integration — the real binary spawned in a temp project with seeded good
//     and bad lessons, asserting the findings, the non-zero exit on issues, a
//     clean exit 0, `--scope`, `--json`, deny suppression, and graceful remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scopeIssue, lintEntry, lintGroups, LINT_RULES, MIN_VALUE_LEN } from '../src/shared/lessons-view.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ── unit: scopeIssue (the canonical scope validator) ──────────────────────────

test('scopeIssue accepts every canonical scope form', () => {
  assert.equal(scopeIssue('global'), null);
  assert.equal(scopeIssue('project::widget'), null);
  assert.equal(scopeIssue('repo::acme/widget'), null);
  assert.equal(scopeIssue('branch::acme/widget::feat/x'), null);
});

test('scopeIssue rejects a single `:` separator and other malformations', () => {
  assert.match(scopeIssue('project:widget'), /single `:`/);
  assert.match(scopeIssue('repo:acme/widget'), /single `:`/);
  assert.match(scopeIssue('bogus::x'), /unrecognized scope type/);
  assert.match(scopeIssue('repo::justowner'), /owner\/name/);
  assert.match(scopeIssue('branch::acme/widget'), /owner\/name::branch/);
  assert.match(scopeIssue(''), /empty/);
});

// ── unit: individual lint rules fire and don't fire ───────────────────────────

test('empty-value fires on blank/whitespace, not on real content', () => {
  assert.ok(LINT_RULES['empty-value']({ value: '' }));
  assert.ok(LINT_RULES['empty-value']({ value: '   \n\t' }));
  assert.equal(LINT_RULES['empty-value']({ value: 'a real lesson body' }), null);
});

test('short-value fires below the threshold but not on empty (mutually exclusive)', () => {
  assert.ok(LINT_RULES['short-value']({ value: 'tiny' }));
  assert.equal(LINT_RULES['short-value']({ value: '' }), null); // empty is empty-value's job
  assert.equal(LINT_RULES['short-value']({ value: 'x'.repeat(MIN_VALUE_LEN) }), null);
  // A custom threshold is honored.
  assert.ok(LINT_RULES['short-value']({ value: 'x'.repeat(MIN_VALUE_LEN) }, { minValueLen: 100 }));
});

test('untrimmed-value fires only when there is surrounding whitespace', () => {
  assert.ok(LINT_RULES['untrimmed-value']({ value: '  padded lesson body  ' }));
  assert.equal(LINT_RULES['untrimmed-value']({ value: 'clean lesson body' }), null);
  assert.equal(LINT_RULES['untrimmed-value']({ value: '' }), null);
});

test('empty-key fires on blank keys only', () => {
  assert.ok(LINT_RULES['empty-key']({ key: '' }));
  assert.ok(LINT_RULES['empty-key']({ key: '   ' }));
  assert.equal(LINT_RULES['empty-key']({ key: 'a-real-key' }), null);
});

test('volatile-key fires on a per-sighting identifier in the key', () => {
  // A GitHub comment id — the shape that froze `seen_count` at 1 in the
  // reviewer-comment-relevance bucket.
  assert.match(
    LINT_RULES['volatile-key']({ key: 'reviewer-comment-relevance::lorekit-231-3681940611' }),
    /3681940611/,
  );
  // A `pr<n>` segment.
  assert.match(
    LINT_RULES['volatile-key']({ key: 'reviewer-comment-relevance::suggestion:pr231-null-check' }),
    /pr231/,
  );
  // An `issue<n>` segment.
  assert.match(LINT_RULES['volatile-key']({ key: 'x::issue4821-thing' }), /issue4821/);
  // A bare 6-digit run is the floor.
  assert.ok(LINT_RULES['volatile-key']({ key: 'x::note:123456' }));
  // Separator forms: the number may be joined by nothing, `-`, or `_`.
  assert.match(LINT_RULES['volatile-key']({ key: 'x::pr-231' }), /pr-231/);
  assert.match(LINT_RULES['volatile-key']({ key: 'x::pr_231' }), /pr_231/);
  assert.match(LINT_RULES['volatile-key']({ key: 'x::issue-4821' }), /issue-4821/);
});

test('volatile-key does NOT fire on legitimate keys that merely contain digits', () => {
  assert.equal(LINT_RULES['volatile-key']({ key: 'reviewer-comment-relevance::issue:oauth2-token-refresh' }), null);
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::nitpick:sha256-not-md5' }), null);
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::suggestion:wcag22-contrast' }), null);
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::note:upgrade-to-v2-3-1' }), null);
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::note:released-in-2026' }), null);
  assert.equal(
    LINT_RULES['volatile-key']({ key: 'reviewer-comment-relevance::suggestion:null-check-guaranteed-upstream' }),
    null,
  );
  // A 5-digit run sits below the conservative floor.
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::note:12345' }), null);
  // An empty key is `empty-key`'s finding, not this rule's.
  assert.equal(LINT_RULES['volatile-key']({ key: '' }), null);
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::note:sprint-2' }), null);
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::note:pr-review' }), null);
  assert.equal(LINT_RULES['volatile-key']({ key: 'x::note:preview-231' }), null);
});

test('volatile-key honors the { volatileKeyAllow } opts hatch', () => {
  const key = 'reviewer-comment-relevance::lorekit-231-3681940611';
  assert.ok(LINT_RULES['volatile-key']({ key }));
  assert.equal(LINT_RULES['volatile-key']({ key }, { volatileKeyAllow: ['3681940611'] }), null);
  assert.equal(LINT_RULES['volatile-key']({ key }, { volatileKeyAllow: ['lorekit-231'] }), null);
  // An unrelated allow entry does not suppress the finding.
  assert.ok(LINT_RULES['volatile-key']({ key }, { volatileKeyAllow: ['something-else'] }));
  // A bare string is tolerated as a one-element list, not iterated character by character.
  assert.equal(LINT_RULES['volatile-key']({ key }, { volatileKeyAllow: 'lorekit-231' }), null);
  assert.ok(LINT_RULES['volatile-key']({ key }, { volatileKeyAllow: 'nope' }));
});

test('lintEntry surfaces volatile-key alongside the other rules', () => {
  const findings = lintEntry({
    scope: 'global',
    key: 'reviewer-comment-relevance::lorekit-231-3681940611',
    value: 'a perfectly fine lesson body',
  });
  assert.deepEqual(findings.map((f) => f.rule), ['volatile-key']);
  // The opts hatch flows through lintEntry too.
  assert.deepEqual(
    lintEntry(
      { scope: 'global', key: 'reviewer-comment-relevance::lorekit-231-3681940611', value: 'a perfectly fine lesson body' },
      { volatileKeyAllow: ['lorekit-231'] },
    ),
    [],
  );
});

test('malformed-scope fires via scopeIssue', () => {
  assert.ok(LINT_RULES['malformed-scope']({ scope: 'project:widget' }));
  assert.equal(LINT_RULES['malformed-scope']({ scope: 'global' }), null);
});

test('lintEntry aggregates every triggered rule; a clean lesson yields none', () => {
  const bad = lintEntry({ scope: 'repo:acme/widget', key: '', value: '  ' });
  const rules = bad.map((f) => f.rule).sort();
  // empty value + empty key + malformed scope all fire (short-value is excluded
  // because the value is empty, and untrimmed doesn't fire on whitespace-only).
  assert.deepEqual(rules, ['empty-key', 'empty-value', 'malformed-scope']);
  assert.deepEqual(lintEntry({ scope: 'global', key: 'k', value: 'a perfectly fine lesson body' }), []);
});

test('lintGroups groups findings by scope, carries errors, counts the total', () => {
  const gathered = {
    groups: [
      { scope: 'global', error: null, entries: [{ scope: 'global', key: 'ok', value: 'a fine long body' }, { scope: 'global', key: '', value: 'x' }] },
      { scope: 'repo::a/b', error: 'fetch failed', entries: [] },
    ],
  };
  const { groups, total } = lintGroups(gathered);
  assert.equal(groups[0].findings.length, 2); // empty-key + short-value on the 2nd entry
  assert.equal(groups[1].error, 'fetch failed');
  assert.equal(total, 2);
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

// A project (no git remote → project + global scopes) with one good global
// lesson and three bad project lessons (short value; padded/untrimmed value;
// volatile key).
function seedProject() {
  const root = tmp('lk-lint-proj-');
  const home = tmp('lk-lint-home-');
  const projectName = path.basename(root).toLowerCase();
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.mkdirSync(path.join(store, 'project', projectName), { recursive: true });
  const write = (rel, e) => fs.writeFileSync(path.join(store, rel), entry(e));
  write('global/a.md', { scope: 'global', key: 'prefer-guard-clauses', value: 'Use early returns to reduce nesting.' });
  write(`project/${projectName}/b.md`, { scope: `project::${projectName}`, key: 'tiny', value: 'ok' });
  write(`project/${projectName}/c.md`, {
    scope: `project::${projectName}`,
    key: 'padded',
    value: '   a body with surrounding whitespace here   ',
  });
  write(`project/${projectName}/d.md`, {
    scope: `project::${projectName}`,
    key: 'pr-231-null-check',
    value: 'A durable observation keyed to a single pull request instead of the pattern.',
  });
  return { root, home, projectName };
}

// An all-clean project — every lesson passes every rule.
function seedClean() {
  const root = tmp('lk-lint-clean-');
  const home = tmp('lk-lint-chome-');
  const store = path.join(root, '.lorekit');
  fs.mkdirSync(path.join(store, 'global'), { recursive: true });
  fs.writeFileSync(
    path.join(store, 'global', 'a.md'),
    entry({ scope: 'global', key: 'good-key', value: 'A durable, well-formed observation.' }),
  );
  return { root, home };
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

function runLint(root, home, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, 'lint', ...extraArgs, '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
  });
}

// ── integration: findings + exit code ─────────────────────────────────────────

test('lint reports findings and exits NON-ZERO when issues exist', () => {
  const { root, home } = seedProject();
  const res = runLint(root, home);
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stdout, /short-value/);
  assert.match(res.stdout, /untrimmed-value/);
  assert.match(res.stdout, /volatile-key/);
  assert.match(res.stdout, /lint issue/);
  assert.doesNotMatch(res.stdout, /Error:/);
});

test('lint --json carries the structured findings list', () => {
  const { root, home, projectName } = seedProject();
  const res = runLint(root, home, ['--json']);
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.total >= 2);
  const proj = out.offline.scopes.find((s) => s.scope === `project::${projectName}`);
  const rules = proj.findings.map((f) => f.rule);
  assert.ok(rules.includes('short-value'));
  assert.ok(rules.includes('untrimmed-value'));
  assert.ok(rules.includes('volatile-key'));
  // The clean global lesson contributes no findings.
  const glob = out.offline.scopes.find((s) => s.scope === 'global');
  assert.equal(glob.findings.length, 0);
});

test('lint on a clean store exits 0 with a green summary', () => {
  const { root, home } = seedClean();
  const res = runLint(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /no lint issues/);
});

test('lint --scope narrows the linted scope', () => {
  const { root, home } = seedProject();
  const res = runLint(root, home, ['--scope', 'global', '--json']);
  assert.equal(res.status, 0, res.stderr); // global lesson is clean → exit 0
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.scopes, ['global']);
  assert.equal(out.total, 0);
});

// ── integration: deny + graceful remote ───────────────────────────────────────

test('LOREKIT_DENY=local suppresses offline linting (remote unavailable → exit 0)', () => {
  const { root, home } = seedProject();
  const res = runLint(root, home, ['--json'], { LOREKIT_DENY: 'local' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.offline.available, false);
  assert.match(out.offline.reason, /deny constraint/);
  assert.equal(out.total, 0);
});

test('lint degrades an unconfigured remote to a note, never an error', () => {
  const { root, home } = seedClean();
  const res = runLint(root, home);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Remote/);
  assert.match(res.stdout, /unavailable/);
});
