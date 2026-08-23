// Tests for the zero-dependency `.env` loader: the pure parser (quotes,
// comments, export prefix, invalid keys) and loadDotEnv's non-overriding,
// never-throwing file behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseDotEnv, loadDotEnv } from '../src/shared/dotenv.mjs';

// ── parseDotEnv (pure) ─────────────────────────────────────────────────────────

test('parses simple KEY=VALUE pairs', () => {
  assert.deepEqual(parseDotEnv('A=1\nB=two'), { A: '1', B: 'two' });
});

test('ignores blank lines and # comments', () => {
  assert.deepEqual(parseDotEnv('\n# a comment\nA=1\n\n  # indented\nB=2\n'), { A: '1', B: '2' });
});

test('strips an optional `export ` prefix', () => {
  assert.deepEqual(parseDotEnv('export TOKEN=abc'), { TOKEN: 'abc' });
});

test('unwraps double quotes and unescapes \\n', () => {
  assert.deepEqual(parseDotEnv('A="line1\\nline2"'), { A: 'line1\nline2' });
});

test('unwraps single quotes literally (no unescaping)', () => {
  assert.deepEqual(parseDotEnv("A='line1\\nline2'"), { A: 'line1\\nline2' });
});

test('drops trailing inline comment on unquoted values', () => {
  assert.deepEqual(parseDotEnv('A=value # trailing'), { A: 'value' });
});

test('keeps # when part of an unquoted value with no preceding space', () => {
  assert.deepEqual(parseDotEnv('A=ab#cd'), { A: 'ab#cd' });
});

test('keeps # inside a quoted value', () => {
  assert.deepEqual(parseDotEnv('A="ab # cd"'), { A: 'ab # cd' });
});

test('skips invalid keys and keyless lines', () => {
  assert.deepEqual(parseDotEnv('1BAD=x\nAL SO=y\n=nokey\nGOOD=z'), { GOOD: 'z' });
});

test('trims surrounding whitespace around key and unquoted value', () => {
  assert.deepEqual(parseDotEnv('  A =  b  '), { A: 'b' });
});

test('empty input yields an empty object', () => {
  assert.deepEqual(parseDotEnv(''), {});
  assert.deepEqual(parseDotEnv(undefined), {});
});

// ── loadDotEnv (impure, best-effort) ───────────────────────────────────────────

function withTmpEnvFile(contents, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lorekit-dotenv-'));
  try {
    writeFileSync(path.join(dir, '.env'), contents);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loads values into a target env object', () => {
  withTmpEnvFile('LOREKIT_TELEMETRY_TOKEN=tok123\nFOO=bar', (dir) => {
    const env = {};
    const applied = loadDotEnv({ cwd: dir, env });
    assert.equal(env.LOREKIT_TELEMETRY_TOKEN, 'tok123');
    assert.equal(env.FOO, 'bar');
    assert.deepEqual(applied.sort(), ['FOO', 'LOREKIT_TELEMETRY_TOKEN']);
  });
});

test('does not override an already-set env var', () => {
  withTmpEnvFile('TOKEN=fromfile', (dir) => {
    const env = { TOKEN: 'fromshell' };
    const applied = loadDotEnv({ cwd: dir, env });
    assert.equal(env.TOKEN, 'fromshell'); // real env wins
    assert.deepEqual(applied, []);
  });
});

test('missing .env is a silent no-op', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lorekit-dotenv-empty-'));
  try {
    const env = {};
    assert.deepEqual(loadDotEnv({ cwd: dir, env }), []);
    assert.deepEqual(env, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
