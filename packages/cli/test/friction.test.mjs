import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  detectFriction,
  readSessionFriction,
  shouldRetrospect,
  STUCK_LOOP_THRESHOLD,
  FRICTION_FAILURE,
  FRICTION_STUCK_LOOP,
} from '../src/core/friction.mjs';
import { normalizeStopMode } from '../src/shared/control.mjs';

// Build a JSONL transcript from message-content arrays.
function transcript(...lines) {
  return lines.map((content) => JSON.stringify({ message: { content } })).join('\n');
}
const toolUse = (name, input) => ({ type: 'tool_use', name, input });
const toolOk = () => ({ type: 'tool_result', content: 'ok' });
const toolErr = () => ({ type: 'tool_result', content: 'boom', is_error: true });

// ── detectFriction ───────────────────────────────────────────────────────────

test('detectFriction: a clean session has no friction', () => {
  const text = transcript([toolUse('Read', { a: 1 })], [toolOk()], [toolUse('Edit', { b: 2 })], [toolOk()]);
  assert.deepEqual(detectFriction(text), { friction: false, reasons: [] });
});

test('detectFriction: an errored tool result flags a failure', () => {
  const text = transcript([toolUse('Bash', { cmd: 'x' })], [toolErr()]);
  const out = detectFriction(text);
  assert.equal(out.friction, true);
  assert.ok(out.reasons.includes(FRICTION_FAILURE));
});

test('detectFriction: identical repeated calls at the threshold flag a stuck loop', () => {
  const call = toolUse('Bash', { cmd: 'flaky' });
  const lines = [];
  for (let i = 0; i < STUCK_LOOP_THRESHOLD; i++) lines.push([call], [toolOk()]);
  const out = detectFriction(transcript(...lines));
  assert.equal(out.friction, true);
  assert.ok(out.reasons.includes(FRICTION_STUCK_LOOP));
});

test('detectFriction: distinct calls below the threshold do not flag a loop', () => {
  const out = detectFriction(
    transcript([toolUse('Bash', { cmd: 'a' })], [toolUse('Bash', { cmd: 'b' })]),
  );
  assert.equal(out.friction, false);
});

test('detectFriction: empty / non-string / malformed input is friction-free, never throws', () => {
  assert.deepEqual(detectFriction(''), { friction: false, reasons: [] });
  assert.deepEqual(detectFriction(null), { friction: false, reasons: [] });
  assert.deepEqual(detectFriction('not json\n{bad'), { friction: false, reasons: [] });
});

// ── readSessionFriction (IO) ─────────────────────────────────────────────────

test('readSessionFriction: unknown (null) when the path is missing or unreadable', () => {
  assert.deepEqual(readSessionFriction(null), { friction: null, reasons: [] });
  assert.deepEqual(readSessionFriction('/no/such/transcript.jsonl'), { friction: null, reasons: [] });
});

test('readSessionFriction: reads a real file and reports friction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-friction-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, transcript([toolUse('Bash', { cmd: 'x' })], [toolErr()]));
  const out = readSessionFriction(file);
  assert.equal(out.friction, true);
  assert.ok(out.reasons.includes(FRICTION_FAILURE));
});

// ── shouldRetrospect gating matrix ───────────────────────────────────────────

test('shouldRetrospect: off never fires', () => {
  for (const f of [true, false, null]) assert.equal(shouldRetrospect('off', f), false);
});

test('shouldRetrospect: always fires regardless of friction', () => {
  for (const f of [true, false, null]) assert.equal(shouldRetrospect('always', f), true);
});

test('shouldRetrospect: friction fires only when friction is not positively absent', () => {
  assert.equal(shouldRetrospect('friction', true), true);
  assert.equal(shouldRetrospect('friction', false), false);
  // null = undetectable (e.g. no transcript on Cursor/Codex) → fire, don't lose lessons.
  assert.equal(shouldRetrospect('friction', null), true);
});

// ── end-to-end: hook.mjs Stop with a transcript_path payload ─────────────────
// The pure pieces above are covered in isolation; this drives the real `hook`
// binary the way Claude Code does (Stop JSON on stdin, `transcript_path` set)
// so the headline behaviour — friction mode staying SILENT on a clean session
// and firing on a session that hit friction — is exercised end to end.

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

// Run `lorekit hook --adapter claude --event Stop` with a Stop payload, fully
// isolated from the developer's real config/store/state so the assertions are
// deterministic. Returns the hook's stdout.
function runStopHook(transcriptText) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-hook-proj-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-hook-home-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-hook-state-'));
  const transcript = path.join(projectDir, 'transcript.jsonl');
  fs.writeFileSync(transcript, transcriptText);
  const payload = JSON.stringify({
    hook_event_name: 'Stop',
    session_id: `sess-${Math.random().toString(36).slice(2)}`,
    transcript_path: transcript,
    cwd: projectDir,
  });
  return execFileSync(process.execPath, [BIN, 'hook', '--adapter', 'claude', '--event', 'Stop'], {
    input: payload,
    encoding: 'utf8',
    cwd: projectDir,
    env: {
      ...process.env,
      HOME: homeDir,
      LOREKIT_HOME: homeDir,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_DATA: stateDir, // isolate the once-per-session throttle
    },
  });
}

test('hook (Stop, friction default): stays silent on a clean session', () => {
  const clean = transcript([toolUse('Read', { a: 1 })], [toolOk()]);
  assert.equal(runStopHook(clean).trim(), '');
});

test('hook (Stop, friction default): nudges when the session hit friction', () => {
  const withFriction = transcript([toolUse('Bash', { cmd: 'x' })], [toolErr()]);
  const out = runStopHook(withFriction);
  assert.match(out, /memory\.write/);
});

// ── normalizeStopMode ────────────────────────────────────────────────────────

test('normalizeStopMode: accepts friendly spellings and rejects garbage', () => {
  assert.equal(normalizeStopMode('friction'), 'friction');
  assert.equal(normalizeStopMode('smart'), 'friction');
  assert.equal(normalizeStopMode('Always'), 'always');
  assert.equal(normalizeStopMode('on'), 'always');
  assert.equal(normalizeStopMode('OFF'), 'off');
  assert.equal(normalizeStopMode('never'), 'off');
  assert.equal(normalizeStopMode('nonsense'), null);
  assert.equal(normalizeStopMode(42), null);
});
