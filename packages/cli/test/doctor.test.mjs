// `lorekit doctor` skill discovery: the check must find the skill whether it
// was installed into the project (.claude/skills) or globally (~/.claude/skills).
//
// Regression guard for the dogfood finding: a `lorekit install --global` writes
// the skill under ~/.claude, but doctor used to only look in the project dir, so
// it reported a perfectly healthy global install as "skill … not found". These
// tests spawn the real binary in `--mode off` (no network) and assert the skill
// status line for each install location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../src/install.mjs';
import { CLAUDE_HOOK_EVENTS } from '../src/config.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Run doctor offline (`--mode off` skips connectivity) with an isolated HOME so
// the global skill dir resolves into our temp home, never the real ~/.claude.
function runDoctor(dir, home) {
  return spawnSync(process.execPath, [BIN, 'doctor', '--mode', 'off', '--dir', dir], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home },
  });
}

// The status line for a given skill from doctor's output.
const skillLineFor = (stdout, name) =>
  stdout.split('\n').find((l) => l.includes(`skill ${name}`)) ?? '';
// The primary "skill lorekit-memory" status line (most assertions key on it).
const skillLine = (stdout) => skillLineFor(stdout, 'lorekit-memory');

// Install with HOME pinned to `home` (global install targets homeDir()).
async function installWith(opts, home) {
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await install(opts);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

test('doctor finds a project-installed skill', async () => {
  const root = tmp('lk-doc-proj-');
  const home = tmp('lk-doc-home-'); // empty home — skill lives only in the project
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }, home);

  const res = runDoctor(root, home);
  const line = skillLine(res.stdout);
  assert.match(line, /PASS/, `expected skill PASS, got: ${line}`);
  assert.doesNotMatch(line, /not found/);

  // doctor checks every shipped skill, not just the primary one.
  const setupLine = skillLineFor(res.stdout, 'lorekit-setup');
  assert.match(setupLine, /PASS/, `expected lorekit-setup PASS, got: ${setupLine}`);
});

test('doctor finds a GLOBAL-installed skill (regression: was reported "not found")', async () => {
  const home = tmp('lk-doc-ghome-');
  const root = tmp('lk-doc-gcwd-'); // empty project — skill lives only under ~/.claude
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true }, home);

  // Sanity: the skill really is only in the global location, not the project.
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'lorekit-memory', 'SKILL.md')));

  const res = runDoctor(root, home);
  const line = skillLine(res.stdout);
  assert.match(line, /PASS/, `global skill should be found, got: ${line}`);
  assert.doesNotMatch(line, /not found/);
});

test('doctor reports the skill missing when it is installed nowhere (and exits non-zero)', () => {
  const root = tmp('lk-doc-none-');
  const home = tmp('lk-doc-nhome-');

  const res = runDoctor(root, home);
  const line = skillLine(res.stdout);
  assert.match(line, /FAIL/, `expected skill FAIL, got: ${line}`);
  assert.match(line, /not found/);
  assert.equal(res.status, 1, 'a missing skill makes doctor exit non-zero');
});

test('doctor warns when hooks are registered in both project and global settings', async () => {
  const root = tmp('lk-doc-dupe-proj-');
  const home = tmp('lk-doc-dupe-home-');

  // Install in BOTH scopes — this is exactly how duplicates arise.
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }, home);
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, global: true }, home);

  const res = runDoctor(root, home);
  // The duplicate warning line must be present.
  const dupeLine = res.stdout.split('\n').find((l) => l.includes('hooks duplicate')) ?? '';
  assert.match(dupeLine, /WARN/, `expected hooks duplicate WARN, got: ${dupeLine}`);
  assert.match(dupeLine, /SessionStart/, `expected SessionStart in duplicate line, got: ${dupeLine}`);
  assert.match(dupeLine, /lorekit uninstall/, `expected uninstall hint, got: ${dupeLine}`);
});

// ── the token is actually VERIFIED, not just prefix-checked ──────────────────
//
// Regression guard for the dogfood finding that motivated this: with a REVOKED
// token, doctor reported `token — read+write (lk_rw_*)` and `connectivity —
// reachable` and summarised "0 failed", while every remote read in `lorekit
// list` answered "Authentication required". Both green checks were honest about
// what they measured and neither measured the credential: `token` reads the
// PREFIX of a string, and `connectivity` probes the PUBLIC `/health` function.
// These tests pin the authenticated probe that closes that gap.

// A mock LoreKit deployment: a public `/functions/v1/health` plus a
// `/functions/v1/memories` that answers with whatever status the case needs.
function startMockDeployment({ memoriesStatus = 200, memoriesBody = '{"entries":[]}' } = {}) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {}); // drain
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://localhost');
      res.setHeader('content-type', 'application/json');
      if (pathname === '/functions/v1/health') {
        res.statusCode = 200;
        res.end('{"status":"ok"}');
        return;
      }
      if (pathname === '/functions/v1/memories') {
        res.statusCode = memoriesStatus;
        res.end(memoriesBody);
        return;
      }
      res.statusCode = 404;
      res.end('{"error":"Route not found","code":"not_found"}');
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Run doctor in remote mode against a mock deployment; returns its output.
//
// Async `spawn`, never `spawnSync`: the mock server lives in THIS process, so a
// synchronous child would block the event loop that has to answer its requests
// and every probe would time out.
function runRemoteDoctor(dir, home, port, token) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        BIN, 'doctor',
        '--mode', 'remote',
        '--endpoint', `http://127.0.0.1:${port}/functions/v1/mcp`,
        '--token', token,
        '--dir', dir,
      ],
      { env: { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home, LOREKIT_TELEMETRY: '0' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const lineFor = (stdout, label) => stdout.split('\n').find((l) => l.includes(label)) ?? '';

test('doctor FAILS the authentication check when the token has been revoked (401)', async () => {
  const root = tmp('lk-doc-revoked-');
  const home = tmp('lk-doc-revoked-home-');
  const server = startMockDeployment({
    memoriesStatus: 401,
    memoriesBody: '{"error":"Authentication required","code":"unauthorized"}',
  });
  const port = await listen(server);
  try {
    const res = await runRemoteDoctor(root, home, port, 'lk_rw_revoked');

    // The transport really is reachable — that check stays honest, and says so.
    const connectivity = lineFor(res.stdout, 'connectivity');
    assert.match(connectivity, /PASS/, `expected connectivity PASS, got: ${connectivity}`);
    assert.match(connectivity, /token not checked/, `connectivity must not imply the token works: ${connectivity}`);

    // …and the credential is reported as broken, not silently accepted.
    const auth = lineFor(res.stdout, 'authentication');
    assert.match(auth, /FAIL/, `expected authentication FAIL, got: ${auth}`);
    assert.match(auth, /revoked/i, `expected an actionable revoked-token message, got: ${auth}`);
    assert.match(auth, /install --force/, `expected the remediation hint, got: ${auth}`);
    assert.equal(res.status, 1, 'a rejected token makes doctor exit non-zero');
  } finally {
    server.close();
  }
});

test('doctor PASSES the authentication check for a token the server accepts', async () => {
  const root = tmp('lk-doc-livetok-');
  const home = tmp('lk-doc-livetok-home-');
  const server = startMockDeployment({ memoriesStatus: 200 });
  const port = await listen(server);
  try {
    const res = await runRemoteDoctor(root, home, port, 'lk_rw_live');
    const auth = lineFor(res.stdout, 'authentication');
    assert.match(auth, /PASS/, `expected authentication PASS, got: ${auth}`);
    assert.match(auth, /read access confirmed/, auth);
  } finally {
    server.close();
  }
});

test('doctor does not call a write-only token broken: 403 is accepted-but-unpermitted', async () => {
  const root = tmp('lk-doc-wo-');
  const home = tmp('lk-doc-wo-home-');
  const server = startMockDeployment({
    memoriesStatus: 403,
    memoriesBody: '{"error":"Read permission required","code":"forbidden"}',
  });
  const port = await listen(server);
  try {
    const res = await runRemoteDoctor(root, home, port, 'lk_wo_live');
    const auth = lineFor(res.stdout, 'authentication');
    assert.match(auth, /PASS/, `a write-only token is healthy, got: ${auth}`);
    assert.match(auth, /no read permission/, auth);
  } finally {
    server.close();
  }
});

test('doctor does NOT warn about duplicates when hooks exist only in one scope', async () => {
  const root = tmp('lk-doc-nodupe-');
  const home = tmp('lk-doc-nodupe-home-');

  // Project-only install — no duplicate.
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }, home);

  const res = runDoctor(root, home);
  const dupeLine = res.stdout.split('\n').find((l) => l.includes('hooks duplicate')) ?? '';
  assert.equal(dupeLine, '', `expected no hooks duplicate line, got: ${dupeLine}`);
});

// ── Hook wiring is a user choice, so doctor must report it ───────────────────

test('doctor reports which hooks are wired and in which scope', async () => {
  const root = tmp('lk-doc-hooks-');
  const home = tmp('lk-doc-hooks-home-');
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }, home);

  const line = (runDoctor(root, home).stdout.split('\n').find((l) => l.includes('hooks project'))) ?? '';
  assert.match(line, /PASS/, `expected a passing hooks line, got: ${line}`);
  assert.match(line, /all/, 'names the resolved mode');
  // Derived from the constant, never a hardcoded list — see install.test.mjs.
  for (const event of CLAUDE_HOOK_EVENTS) {
    assert.match(line, new RegExp(event), `names ${event}`);
  }
});

test('doctor names the upgrade a legacy hook wiring still reports as `all`', async () => {
  // A pre-UserPromptSubmit install reads as `all` (LEGACY_ALL_EVENT_SETS), so
  // the mode alone told the user they were current when they were not. It stays
  // a PASS — the wiring works — but it must name the gap and the command, the
  // same upgrade `install`'s already-installed summary reports.
  const root = tmp('lk-doc-legacy-');
  const home = tmp('lk-doc-legacy-home-');
  await installWith({ dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true }, home);

  // Roll the wiring back to the legacy triple the way an old install left it.
  const settings = path.join(root, '.claude', 'settings.json');
  const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'));
  delete parsed.hooks.UserPromptSubmit;
  fs.writeFileSync(settings, JSON.stringify(parsed, null, 2));

  const res = runDoctor(root, home);
  const line = res.stdout.split('\n').find((l) => l.includes('hooks project')) ?? '';
  assert.match(line, /PASS/, `a stale wiring still works, so it is not a failure: ${line}`);
  assert.match(line, /missing UserPromptSubmit/, `names the gap, got: ${line}`);
  assert.match(line, /lorekit install --hooks all/, `names the command, got: ${line}`);
  assert.equal(res.status, 0, 'and the advisory never changes doctor\'s exit code');
});

test('doctor says so when no hooks are wired, so a deliberate opt-out is legible', async () => {
  const root = tmp('lk-doc-nohooks-');
  const home = tmp('lk-doc-nohooks-home-');
  await installWith(
    { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true, hooks: 'none' },
    home,
  );

  const out = runDoctor(root, home).stdout;
  const line = out.split('\n').find((l) => /\bhooks\b/.test(l)) ?? '';
  assert.match(line, /none wired/, `expected a "none wired" line, got: ${line}`);
  assert.match(line, /--hooks all/, 'tells the user how to change it');
});

test('doctor reports read-only hook wiring distinctly from all', async () => {
  const root = tmp('lk-doc-rohooks-');
  const home = tmp('lk-doc-rohooks-home-');
  await installWith(
    { dir: root, endpoint: ENDPOINT, token: TOKEN, yes: true, project: true, hooks: 'read-only' },
    home,
  );

  const line = (runDoctor(root, home).stdout.split('\n').find((l) => l.includes('hooks project'))) ?? '';
  assert.match(line, /read-only/, `expected read-only, got: ${line}`);
  assert.doesNotMatch(line, /Stop/, 'the retrospective nudge is not wired');
});

// ── `doctor --telemetry` — the OTLP export gate ──────────────────────────────
//
// The check these cover is the one that would have caught a silently-dead
// telemetry export: `exportInvocation` swallows transport errors by design, so
// nothing else in the codebase can tell an accepted span from a rejected one.
//
// These drive the real binary and therefore cover WIRING — the flag reaches the
// check, the check drives the exit code, and the run stays focused. The
// accepted / rejected / probe-payload behaviour is covered in-process in
// telemetry.test.mjs, where a fake collector can be asserted on directly.

// A port nothing listens on, so connect() is refused immediately.
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

function runTelemetryDoctor(extraEnv = {}, { cwd, dir = tmp('lk-doc-otlp-') } = {}) {
  return spawnSync(process.execPath, [BIN, 'doctor', '--telemetry', '--dir', dir], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: dir,
      USERPROFILE: dir,
      OTEL_EXPORTER_OTLP_ENDPOINT: DEAD_ENDPOINT,
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer probe_tok',
      LOREKIT_TELEMETRY: '',
      DO_NOT_TRACK: '',
      ...extraEnv,
    },
  });
}

// The telemetry check reads `.lorekit.json` from the `--dir` root, like every
// other check — NOT from the shell's working directory. Without this, a
// developer with `telemetry.disabled` in the directory they happen to stand in
// fails the CI gate for a completely unrelated project.
test('doctor --telemetry reads .lorekit.json from --dir, not from the cwd', () => {
  const elsewhere = tmp('lk-doc-otlp-cwd-');
  fs.writeFileSync(path.join(elsewhere, '.lorekit.json'), JSON.stringify({ 'telemetry.disabled': true }));

  const fromElsewhere = runTelemetryDoctor({}, { cwd: elsewhere });
  assert.doesNotMatch(
    fromElsewhere.stdout,
    /opted out/,
    'a disabled .lorekit.json in the cwd must not decide the verdict for another --dir',
  );

  const target = tmp('lk-doc-otlp-dir-');
  fs.writeFileSync(path.join(target, '.lorekit.json'), JSON.stringify({ 'telemetry.disabled': true }));
  const fromDir = runTelemetryDoctor({}, { dir: target });
  assert.match(fromDir.stdout, /opted out/, 'the --dir root\u2019s own opt-out must still be honoured');
});

test('doctor --telemetry FAILS when the OTLP endpoint is unreachable', () => {
  const run = runTelemetryDoctor();
  assert.equal(run.status, 1, 'a dead export path must be a hard failure — that is the whole point');
  assert.match(run.stdout, /could not reach/i);
});

test('doctor --telemetry FAILS when export is opted out — a silent CI gate is no gate', () => {
  const run = runTelemetryDoctor({ DO_NOT_TRACK: '1' });
  assert.equal(run.status, 1, 'opting out must not turn the gate green');
  assert.match(run.stdout, /export off/);
});

test('doctor --telemetry reports an unusable OTLP header as a credential problem, not an opt-out', () => {
  // `OTEL_EXPORTER_OTLP_HEADERS` is set but parses to zero headers, so nothing
  // authenticates. Reporting that as "opted out via LOREKIT_TELEMETRY /
  // DO_NOT_TRACK" sends the operator looking for an opt-out that isn't there.
  const run = runTelemetryDoctor({ OTEL_EXPORTER_OTLP_ENDPOINT: '', OTEL_EXPORTER_OTLP_HEADERS: 'garbage' });
  assert.match(run.stdout, /no OTLP credential resolved/);
  assert.doesNotMatch(run.stdout, /opted out/);
});

// Wiring counterpart to the in-process partial-success tests: prove the new
// verdict reaches the EXIT CODE. A collector that answers 200 while dropping
// the span used to produce a green gate, which is the precise CI outcome this
// flag exists to prevent.
test('doctor --telemetry FAILS on a 200 that rejected the probe span', async () => {
  const collector = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ partialSuccess: { rejectedSpans: '1', errorMessage: 'dataset not found' } }));
  });
  const port = await listen(collector);
  try {
    // Async `spawn` for the same reason `runRemoteDoctor` uses it: the
    // collector lives in THIS process, so a synchronous child would block the
    // event loop that has to answer the probe.
    const dir = tmp('lk-doc-otlp-partial-');
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN, 'doctor', '--telemetry', '--dir', dir], {
        env: {
          ...process.env,
          NO_COLOR: '1',
          HOME: dir,
          USERPROFILE: dir,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
          OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer probe_tok',
          LOREKIT_TELEMETRY: '',
          DO_NOT_TRACK: '',
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (status) => resolve({ status, stdout }));
    });

    assert.equal(res.status, 1, 'a dropped span must not pass the gate just because the POST returned 200');
    assert.match(res.stdout, /rejectedSpans=1/);
    assert.match(res.stdout, /dataset not found/);
  } finally {
    collector.close();
  }
});

test('doctor --telemetry is focused — it does not run the skill or backend checks', () => {
  // A bare temp dir has no skills and no .mcp.json. If the focused run swept
  // those too, its exit code would say nothing about telemetry specifically.
  const run = runTelemetryDoctor();
  assert.doesNotMatch(run.stdout, /skill lorekit-memory/);
  assert.doesNotMatch(run.stdout, /\.mcp\.json/);
  assert.doesNotMatch(run.stdout, /memory mode/);
});

test('a default doctor run reports telemetry as info and never fails on it', () => {
  const dir = tmp('lk-doc-otlp-info-');
  const run = spawnSync(process.execPath, [BIN, 'doctor', '--mode', 'off', '--dir', dir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      HOME: dir,
      USERPROFILE: dir,
      // No OTLP credential resolves here (the committed token is empty), so the
      // line must read as information, not as a failed check — an end user with
      // no phone-home is not a broken install.
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_HEADERS: '',
      LOREKIT_TELEMETRY_TOKEN: '',
    },
  });
  const line = run.stdout.split('\n').find((l) => l.includes('telemetry')) ?? '';
  assert.match(line, /export off/, `expected a telemetry line, got: ${line}`);
  assert.doesNotMatch(line, /FAIL/, 'a user with no phone-home is not broken');
});
