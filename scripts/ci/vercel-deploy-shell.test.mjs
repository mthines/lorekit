// Guards the `shell:` line of the Vercel preview deploy step against a silent
// regression to `shell: bash`.
//
// The bug this exists for: GitHub expands `shell: bash` to
// `bash --noprofile --norc -e -o pipefail {0}`, and a `set -uo pipefail` inside
// the script does NOT clear an inherited `-e`. The deploy step captures the
// CLI's exit code:
//
//     out="$(timeout … vercel deploy --prebuilt … 2>"$err_file")"
//     code=$?
//
// That assignment is a SIMPLE COMMAND, so under `-e` a non-zero `vercel` exit
// aborts the step right there. `code=$?` and every `fail()` branch below it are
// unreachable — Vercel's own stated reason is written to `$err_file` and thrown
// away unread, and the caller gets a bare exit code with no `::error::` and no
// `vercel-deploy-error.txt` to quote. A quota block reads as an unexplained
// timeout. That is exactly how it presented on mthines/lorekit#643, and it cost
// hours of misdiagnosis before the real cause (an account-level 24h upload
// quota) was found somewhere else entirely.
//
// Two things are under test, and the first is the point:
//   1. The bash semantics themselves — the same script shape run under both
//      shell spellings, asserting the handler is unreachable under `-e` and
//      reachable without it. Without this the rule below is folklore.
//   2. YAML parity — every composite step in the action that reads `$?` in an
//      unguarded position declares a shell that opts out of `-e`. The
//      classifiers doing that reading are themselves tested against a case
//      table, so a guard that silently stops matching is a red test.
//
// Run: node --test scripts/ci/vercel-deploy-shell.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ACTION = '.github/actions/vercel-preview-deploy/action.yml';

// ── The classifiers ─────────────────────────────────────────────────────────

/**
 * Does this `shell:` value run the script WITHOUT `errexit`?
 *
 * A bare keyword (`bash`, `sh`) is a GitHub alias, and every one of them adds
 * `-e`. Only an explicit command line containing the `{0}` script placeholder
 * chooses its own flags — and then only if it does not ask for `-e` itself.
 * Anything that is not bash/sh (pwsh, python, node) is not our concern.
 */
export function optsOutOfErrexit(shellValue) {
  const spec = shellValue.trim();
  if (!spec.includes('{0}')) return false; // a GitHub alias — `-e` is implied
  if (!/^(bash|sh)\b/.test(spec)) return false; // not a POSIX shell script
  // `-e` as its own flag, or bundled into a cluster like `-euo`. `--noprofile`
  // and `--norc` are long options and must not match.
  return !/(^|\s)-[A-Za-z]*e[A-Za-z]*(\s|$)/.test(spec) && !/(^|\s)-o\s+errexit(\s|$)/.test(spec);
}

/**
 * Does this script read `$?` somewhere `errexit` would have already aborted?
 *
 * `cmd || rc=$?` is safe: `-e` exempts a non-final command of an AND/OR list,
 * which is why the alias step's `if out="$(…)"` shape needs no opt-out. A bare
 * `code=$?` on its own line is not safe — the command it is reporting on is a
 * simple command, and under `-e` the script never reaches this line.
 */
export function readsExitCodeUnguarded(runScript) {
  return runScript.split('\n').some((line) => {
    const code = line.replace(/#.*$/, '');
    if (!code.includes('$?')) return false;
    // Guarded when the `$?` read is the right-hand side of an `&&`/`||` list.
    const beforeRead = code.slice(0, code.indexOf('$?'));
    return !/(\|\||&&)/.test(beforeRead);
  });
}

/**
 * Split a composite action's `runs.steps` into `{ name, shell, run }`.
 *
 * Steps are the 4-space-indented `- name:` entries; a `run: |` block runs to
 * the next such entry. Hand-rolled because this job installs no dependencies —
 * the same constraint every sibling guard in scripts/ci/ works under.
 */
export function compositeSteps(yaml) {
  const lines = yaml.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (/^ {4}- name: /.test(line)) starts.push(i);
  });
  return starts.map((start, n) => {
    const end = starts[n + 1] ?? lines.length;
    const body = lines.slice(start, end);
    const shell = body.find((l) => /^ {6}shell: /.test(l));
    const runAt = body.findIndex((l) => /^ {6}run: /.test(l));
    return {
      name: body[0].replace(/^ {4}- name: /, '').trim(),
      shell: shell ? shell.replace(/^ {6}shell: /, '').trim() : null,
      run: runAt === -1 ? '' : body.slice(runAt).join('\n'),
    };
  });
}

// ── 1. The bash semantics the rule rests on ─────────────────────────────────

test('`-e` makes an exit-code handler after a captured command unreachable', () => {
  // The deploy step's shape, reduced to its skeleton: capture a failing
  // command's output into a variable, then report on its exit code.
  const script = ['set -uo pipefail', 'out="$(timeout 1 false 2>/dev/null)"', 'code=$?', 'echo "HANDLER code=$code"'].join('\n');

  const dir = mkdtempSync(join(tmpdir(), 'vercel-shell-'));
  const path = join(dir, 'step.sh');
  writeFileSync(path, script);

  try {
    // What `shell: bash` expands to.
    const withErrexit = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', path], { encoding: 'utf8' });
    assert.equal(
      withErrexit.stdout.includes('HANDLER'),
      false,
      'under `-e` the handler must be unreachable — if this passes, the bug this ' +
        'guard exists for is not real and the guard should be reconsidered, not relaxed',
    );
    assert.notEqual(withErrexit.status, 0, 'under `-e` the step aborts on the failing capture');

    // What the action declares instead.
    const without = spawnSync('bash', ['--noprofile', '--norc', path], { encoding: 'utf8' });
    assert.match(without.stdout, /HANDLER code=1/, 'without `-e` the handler runs and sees the real exit code');
    assert.equal(without.status, 0, 'without `-e` the script decides its own exit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. The classifiers ──────────────────────────────────────────────────────

test('optsOutOfErrexit reads a `shell:` value correctly', () => {
  const CASES = [
    // The alias GitHub expands to `bash --noprofile --norc -e -o pipefail {0}`.
    ['bash', false],
    ['sh', false],
    // An explicit command line that chooses its own flags.
    ['bash --noprofile --norc {0}', true],
    ['bash {0}', true],
    // …but still asks for errexit, one way or another.
    ['bash -e {0}', false],
    ['bash --noprofile --norc -e -o pipefail {0}', false],
    ['bash -euo pipefail {0}', false],
    ['bash -o errexit {0}', false],
    // Not a POSIX shell — out of scope, never flagged.
    ['pwsh -File {0}', false],
    ['python {0}', false],
  ];
  for (const [value, expected] of CASES) {
    assert.equal(optsOutOfErrexit(value), expected, `optsOutOfErrexit(${JSON.stringify(value)})`);
  }
});

test('readsExitCodeUnguarded tells the broken shape from the safe one', () => {
  const CASES = [
    // The deploy step's shape: the capture is a simple command, so `-e` aborts
    // before the read.
    ['out="$(cmd)"\ncode=$?', true],
    ['code=$?', true],
    ['if [ "$?" -ne 0 ]; then :; fi', true],
    // Guarded: `-e` exempts a non-final command of an AND/OR list.
    ['cmd || rc=$?', false],
    ['cmd && rc=$? || rc=$?', false],
    // The alias step's shape — guarded by `if`, and reads no exit code at all.
    ['if out="$(cmd)"; then echo ok; else echo no; fi', false],
    ['echo done', false],
    // A `$?` inside a comment is not a read.
    ['# code=$? used to live here\necho done', false],
  ];
  for (const [script, expected] of CASES) {
    assert.equal(readsExitCodeUnguarded(script), expected, `readsExitCodeUnguarded(${JSON.stringify(script)})`);
  }
});

// ── 3. YAML parity — the action itself obeys the rule ───────────────────────

test('the action parses into the composite steps we expect', () => {
  const yaml = readFileSync(join(repoRoot, ACTION), 'utf8');
  const steps = compositeSteps(yaml);
  // A parser that silently matched nothing would make every assertion below
  // vacuously true, which is the failure mode a YAML guard actually dies of.
  assert.ok(steps.length >= 5, `expected the parser to find the action's steps, found ${steps.length}`);
  assert.ok(
    steps.some((s) => s.name === 'Deploy (prebuilt)'),
    'the `Deploy (prebuilt)` step was not found — the parser drifted from the YAML',
  );
  // `uses:` steps (pnpm/action-setup, setup-node) carry no shell — a composite
  // action only requires one on a `run` step, and that is the set this guard
  // reasons about.
  const shellless = steps.filter((s) => s.run !== '' && s.shell === null).map((s) => s.name);
  assert.deepEqual(shellless, [], 'a `run` step parsed without a shell — the parser drifted from the YAML');
});

test('the Deploy (prebuilt) step opts out of `-e` (mthines/lorekit#643)', () => {
  const yaml = readFileSync(join(repoRoot, ACTION), 'utf8');
  const deploy = compositeSteps(yaml).find((s) => s.name === 'Deploy (prebuilt)');
  assert.ok(deploy, 'the `Deploy (prebuilt)` step is gone');
  assert.ok(
    readsExitCodeUnguarded(deploy.run),
    'the deploy step no longer captures `$?` — if its error reporting was rewritten, ' +
      'update this guard deliberately rather than deleting it',
  );
  assert.ok(
    optsOutOfErrexit(deploy.shell),
    `the deploy step declares \`shell: ${deploy.shell}\`, which runs under \`-e\`. ` +
      'Its `code=$?` and every fail() branch below it are then unreachable, so a ' +
      'blocked deploy reports no reason and writes no vercel-deploy-error.txt for ' +
      'the caller to quote. Use `bash --noprofile --norc {0}`.',
  );
});

test('no step in the action reads `$?` under an errexit shell', () => {
  const yaml = readFileSync(join(repoRoot, ACTION), 'utf8');
  const offenders = compositeSteps(yaml)
    .filter((s) => readsExitCodeUnguarded(s.run) && !optsOutOfErrexit(s.shell ?? ''))
    .map((s) => `${s.name} (shell: ${s.shell})`);
  assert.deepEqual(
    offenders,
    [],
    'these steps read an exit code the shell will never let them reach:\n  ' + offenders.join('\n  '),
  );
});

test('the caller still reads the reason file the deploy step writes', () => {
  // The two halves are in different files, so nothing but this asserts they
  // agree on the filename — and a mismatch is invisible until a deploy fails.
  const workflow = readFileSync(join(repoRoot, '.github/workflows/web-preview-deploy.yml'), 'utf8');
  const action = readFileSync(join(repoRoot, ACTION), 'utf8');
  assert.ok(action.includes('vercel-deploy-error.txt'), 'the deploy step stopped writing the reason file');
  assert.ok(
    workflow.includes('vercel-deploy-error.txt'),
    'web-preview-deploy.yml stopped reading vercel-deploy-error.txt — the reason ' +
      'the deploy step writes would no longer reach the PR comment',
  );
});
