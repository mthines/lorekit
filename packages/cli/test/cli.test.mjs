// CLI dispatch behavior: per-command help and unknown-flag rejection.
//
// These spawn the real binary so they cover the actual argv → dispatch path in
// bin/lorekit.mjs, not just the parser in isolation:
//   - `lorekit <command> --help` prints focused, command-specific help.
//   - a typo like `--gloabl` on a human command fails loudly (exit 1) instead
//     of being silently ignored and changing behavior.
//   - the machine-facing hook/mcp commands keep their contract: `--help`
//     documents them instead of blocking on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

function run(args, { input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    input: input ?? '', // closed stdin so a stray stdin-read can't hang the test
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('per-command --help prints focused help for each command', () => {
  for (const command of ['install', 'uninstall', 'doctor', 'migrate']) {
    const res = run([command, '--help']);
    assert.equal(res.status, 0, `${command} --help should exit 0`);
    assert.match(res.stdout, new RegExp(`^lorekit ${command}`), `header names ${command}`);
    // Focused help is command-scoped, not the full top-level command list.
    assert.doesNotMatch(res.stdout, /shared persistent memory for coding agents/);
  }
});

test('bare --help prints the top-level help', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /shared persistent memory for coding agents/);
});

test('an unknown flag on a human command fails with a pointer', () => {
  const res = run(['doctor', '--gloabl', '--mode', 'off']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown option: --gloabl/);
  assert.match(res.stderr, /lorekit doctor --help/);
});

test('multiple unknown flags are reported together (plural)', () => {
  const res = run(['install', '--foo', '--bar', '--yes']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown options: --foo, --bar/);
});

test('a valid flag combination is not flagged as unknown', () => {
  // --mode off keeps this offline; the run should not error on flags.
  const res = run(['doctor', '--mode', 'off', '--deep']);
  assert.doesNotMatch(res.stderr, /Unknown option/);
});

test('hook --help documents the command instead of blocking on stdin', () => {
  const res = run(['hook', '--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^lorekit hook/);
});

test('mcp --help documents the command instead of starting the server', () => {
  const res = run(['mcp', '--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^lorekit mcp/);
});
