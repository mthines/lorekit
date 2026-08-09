// Cross-framework conformance:
//   1. Replay recorded/seed payloads through the real binary and assert the
//      stdout matches each host's documented output contract.
//   2. Validate each host's wiring config (Claude via `claude plugin validate`
//      when available; Cursor/Codex structurally).
//   3. Assert the vendored Claude skill is in sync with its single source.
//
// Fixtures live in test/fixtures/. Seed payloads ship with the repo; run each
// framework once with LOREKIT_HOOK_RECORD=<dir> to overwrite them with the real
// payloads that framework sends, then this suite proves conformance offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'lorekit.mjs');
const REPO = path.join(HERE, '..', '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');

function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-fx-'));
}

function runFixture(fx) {
  const args = [BIN, 'hook', '--adapter', fx.adapter, '--dir', REPO];
  if (fx.event) args.push('--event', fx.event);
  return execFileSync('node', args, {
    input: JSON.stringify(fx.stdin),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: freshStateDir() },
  });
}

// Each host's stdout contract. Returns true if `obj` is a valid injection.
function conformsToContract(adapter, event, obj) {
  if (adapter === 'claude' || adapter === 'codex') {
    const h = obj.hookSpecificOutput;
    return !!h && typeof h.additionalContext === 'string' && h.hookEventName === event;
  }
  if (adapter === 'cursor') {
    return typeof obj.followup_message === 'string';
  }
  return false;
}

// Events that MUST produce output regardless of MCP connectivity.
const ALWAYS_EMITS = new Set(['Stop', 'stop', 'PostToolUseFailure']);

const fixtureFiles = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .sort();

test('fixtures exist for every adapter', () => {
  const adapters = new Set(
    fixtureFiles.map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8')).adapter),
  );
  for (const a of ['claude', 'cursor', 'codex']) {
    assert.ok(adapters.has(a), `missing a fixture for adapter "${a}"`);
  }
});

for (const file of fixtureFiles) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  test(`fixture ${file} → output conforms to the ${fx.adapter} contract`, () => {
    const out = runFixture(fx);
    if (out === '') {
      // Empty is only acceptable for events that need MCP connectivity (reads).
      assert.ok(!ALWAYS_EMITS.has(fx.event), `${file} produced no output but its event must always emit`);
      return;
    }
    let obj;
    assert.doesNotThrow(() => (obj = JSON.parse(out)), `${file} produced non-JSON stdout`);
    assert.ok(conformsToContract(fx.adapter, fx.event, obj), `${file} output violates the ${fx.adapter} contract: ${out}`);
  });
}

// The failure path gained relevant-lesson injection, but its output contract is
// unchanged: with no MCP store configured (as here) it must still emit exactly
// the write-nudge, never nothing, and never break the host's JSON shape.
test('the failure path always emits the write-nudge (injection is additive)', () => {
  for (const file of ['claude-PostToolUseFailure.json', 'codex-PostToolUse.json']) {
    const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const out = runFixture(fx);
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /call failed/, `${file} lost its failure nudge`);
  }
});

test('Claude plugin config validates (claude plugin validate)', (t) => {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) {
    t.skip('claude CLI not installed');
    return;
  }
  const res = spawnSync('claude', ['plugin', 'validate', path.join(REPO, 'plugins', 'lorekit-claude')], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(res.status, 0, `claude plugin validate failed:\n${res.stdout}\n${res.stderr}`);
});

test('Cursor hooks.json is structurally valid', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', 'lorekit-cursor', 'hooks.json'), 'utf8'));
  assert.equal(cfg.version, 1);
  assert.ok(Array.isArray(cfg.hooks.stop) && cfg.hooks.stop.length > 0);
  assert.match(cfg.hooks.stop[0].command, /@lorekit\/cli/);
  assert.match(cfg.hooks.stop[0].command, /--adapter cursor/);
  const rule = fs.readFileSync(path.join(REPO, 'plugins', 'lorekit-cursor', 'rules', 'lorekit-memory.mdc'), 'utf8');
  assert.match(rule, /alwaysApply:\s*true/);
});

test('Codex config declares the feature flag, MCP server, and hooks', () => {
  const toml = fs.readFileSync(path.join(REPO, 'plugins', 'lorekit-codex', 'config.toml.example'), 'utf8');
  assert.match(toml, /codex_hooks\s*=\s*true/);
  assert.match(toml, /\[mcp_servers\.lorekit\]/);
  for (const ev of ['SessionStart', 'PostToolUse', 'Stop']) {
    assert.match(toml, new RegExp(`\\[\\[hooks\\.${ev}\\]\\]`), `config.toml missing [[hooks.${ev}]]`);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', 'lorekit-codex', 'hooks.json'), 'utf8'));
  for (const ev of ['SessionStart', 'PostToolUse', 'Stop']) {
    assert.ok(Array.isArray(hooks.hooks[ev]), `hooks.json missing ${ev}`);
  }
});

test('the vendored Claude skill is in sync with its source', () => {
  const res = spawnSync('node', [path.join(REPO, 'scripts', 'sync-plugin-skill.mjs'), '--check'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

// ── UserPromptSubmit: the contract is that SILENCE is valid output ───────────
//
// Every other hook either always emits (`Stop`, `PostToolUseFailure`) or emits
// whatever the store had (`SessionStart`). This one fires on EVERY turn, so its
// contract is the opposite: emitting nothing is the normal, correct answer, and
// the only thing that must hold is that when it does speak it speaks the host's
// JSON. A fixture that produced output here with no store configured would mean
// a gate had come loose.
test('UserPromptSubmit is silent without a store, and never breaks the contract', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claude-UserPromptSubmit.json'), 'utf8'));
  const out = runFixture(fx);
  assert.equal(out, '', 'no store configured → nothing to say, so say nothing');
});

test('UserPromptSubmit stays silent on a trivial prompt', () => {
  // The length gate. These are the acknowledgements that dominate a real
  // session; a store lookup for each one is pure overhead on the user's
  // critical path, and there is nothing in them to match on anyway.
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'claude-UserPromptSubmit.json'), 'utf8'));
  for (const prompt of ['yes', 'ok', 'continue', 'do it', 'next please', '', '   ']) {
    const out = runFixture({ ...base, stdin: { ...base.stdin, prompt } });
    assert.equal(out, '', `a "${prompt}" prompt must not reach the store`);
  }
});
