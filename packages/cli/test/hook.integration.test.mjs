// End-to-end: spawn the real `lorekit hook` binary, feed each host's JSON on
// stdin, and assert the stdout injection. Covers the full path including
// argument parsing, stdin reading, throttling, and (via a mock MCP server)
// the SessionStart lesson-read path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_SESSION_START_MAX_CHARS, MAX_SESSION_START_MAX_LESSONS } from '../src/control.mjs';
import { MAX_STORE_LIST_LIMIT } from '../src/core/lessons.mjs';
import { createTwoTierStore } from '../src/store/index.mjs';
import { deriveScope } from '../src/scope.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-hook-'));
}

// Run the hook binary. Always returns { stdout, code } — the hook must exit 0.
function runHook({ adapter, event, input = {}, dir = REPO, env = {} }) {
  const args = [BIN, 'hook', '--adapter', adapter, '--dir', dir];
  if (event) args.push('--event', event);
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', args, {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { CLAUDE_PLUGIN_DATA: freshStateDir(), ...process.env, ...env },
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout ? String(e.stdout) : '';
  }
  return { stdout, code };
}

// Async variant — required whenever the test process also runs a server the
// child talks to, since execFileSync would block this process's event loop.
function runHookAsync({ adapter, event, input = {}, dir = REPO, env = {} }) {
  return new Promise((resolve) => {
    const args = [BIN, 'hook', '--adapter', adapter, '--dir', dir];
    if (event) args.push('--event', event);
    const child = spawn('node', args, {
      env: { CLAUDE_PLUGIN_DATA: freshStateDir(), ...process.env, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('claude Stop injects a retrospective nudge', () => {
  const { stdout, code } = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'Stop', session_id: 'stop-1' },
  });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(out.hookSpecificOutput.additionalContext, /worth remembering/i);
});

test('claude PostToolUseFailure nudges even with an empty response (guaranteed failure)', () => {
  const { stdout } = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'PostToolUseFailure', session_id: 'f-1', tool_name: 'Edit', tool_response: {} },
  });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /failed/);
});

test('claude PostToolUse with exit_code 0 stays silent', () => {
  const { stdout } = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'PostToolUse', session_id: 'ok-1', tool_name: 'Bash', tool_response: { exit_code: 0 } },
  });
  assert.equal(stdout, '');
});

test('codex PostToolUse uses the failure heuristic (is_error)', () => {
  const { stdout } = runHook({
    adapter: 'codex',
    input: { hook_event_name: 'PostToolUse', session_id: 'cx-1', tool_name: 'shell', tool_response: { is_error: true } },
  });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /failed/);
});

test('cursor stop returns a followup_message', () => {
  const { stdout } = runHook({
    adapter: 'cursor',
    input: { hook_event_name: 'stop', generation_id: 'g-1' },
  });
  assert.match(JSON.parse(stdout).followup_message, /worth remembering/i);
});

test('unknown adapter exits 0 and prints nothing', () => {
  const { stdout, code } = runHook({ adapter: 'nope', input: { hook_event_name: 'Stop' } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('malformed stdin exits 0 and prints nothing', () => {
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', [BIN, 'hook', '--adapter', 'claude', '--event', 'Stop', '--dir', REPO], {
      input: 'this is not json',
      encoding: 'utf8',
      env: { CLAUDE_PLUGIN_DATA: freshStateDir(), ...process.env },
    });
  } catch (e) {
    code = e.status ?? 1;
  }
  // Stop has no tool data and needs no stdin fields, so it still nudges;
  // the point is it must not crash on unparseable input.
  assert.equal(code, 0);
  assert.ok(stdout === '' || stdout.includes('worth remembering'));
});

test('the nudge fires at most once per session (throttle)', () => {
  const state = freshStateDir();
  const input = { hook_event_name: 'Stop', session_id: 'dup-1' };
  const a = runHook({ adapter: 'claude', input, env: { CLAUDE_PLUGIN_DATA: state } });
  const b = runHook({ adapter: 'claude', input, env: { CLAUDE_PLUGIN_DATA: state } });
  assert.notEqual(a.stdout, '');
  assert.equal(b.stdout, ''); // second call in the same session is suppressed
});

// ── Stop friction gating vs. the asynchronous transcript write ───────────────
// friction.test.mjs covers the clean/friction end-to-end pair. These cover the
// case that pair cannot reach: the transcript is written asynchronously and may
// lag the current turn, so a Stop right after a failing tool call can read a
// positively-clean `false`. The PostToolUseFailure marker is the
// transcript-independent witness the Stop path falls back to.

// Write a Claude-shaped JSONL transcript to disk and return its path.
function writeTranscript(dir, ...lines) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.map((content) => JSON.stringify({ message: { content } })).join('\n'));
  return file;
}

test('claude Stop still nudges on a clean transcript when the session recorded a tool failure', () => {
  const dir = freshStateDir();
  const clean = writeTranscript(dir, [{ type: 'tool_result', content: 'ok' }]);
  const failure = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'PostToolUseFailure', session_id: 'lagging-1', tool_name: 'Edit', tool_response: {} },
    env: { CLAUDE_PLUGIN_DATA: dir },
  });
  assert.match(failure.stdout, /failed/); // the marker was written
  const stop = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'Stop', session_id: 'lagging-1', transcript_path: clean },
    env: { CLAUDE_PLUGIN_DATA: dir },
  });
  assert.match(JSON.parse(stop.stdout).hookSpecificOutput.additionalContext, /a failed tool call/);
});

test('a failure marker from a DIFFERENT session does not resurrect the nudge', () => {
  const dir = freshStateDir();
  const clean = writeTranscript(dir, [{ type: 'tool_result', content: 'ok' }]);
  runHook({
    adapter: 'claude',
    input: { hook_event_name: 'PostToolUseFailure', session_id: 'other-session', tool_name: 'Edit', tool_response: {} },
    env: { CLAUDE_PLUGIN_DATA: dir },
  });
  const { stdout } = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'Stop', session_id: 'lagging-2', transcript_path: clean },
    env: { CLAUDE_PLUGIN_DATA: dir },
  });
  assert.equal(stdout, '');
});

test('the Stop friction gate does not consume the retro marker when it stays silent', () => {
  const dir = freshStateDir();
  const clean = writeTranscript(dir, [{ type: 'tool_result', content: 'ok' }]);
  const first = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'Stop', session_id: 'late-friction', transcript_path: clean },
    env: { CLAUDE_PLUGIN_DATA: dir },
  });
  assert.equal(first.stdout, '');
  // Same session, later turn: the transcript now carries the failure.
  fs.appendFileSync(clean, `\n${JSON.stringify({ message: { content: [{ type: 'tool_result', content: 'boom', is_error: true }] } })}`);
  const second = runHook({
    adapter: 'claude',
    input: { hook_event_name: 'Stop', session_id: 'late-friction', transcript_path: clean },
    env: { CLAUDE_PLUGIN_DATA: dir },
  });
  assert.match(JSON.parse(second.stdout).hookSpecificOutput.additionalContext, /a failed tool call/);
});

// A mock REST endpoint. `GET /memories` (list) returns `listEntries` — what a
// SessionStart injection sees; `POST /memories/search` NARROWS `searchEntries`
// by the query (a loose substring stand-in for the server's FTS, splitting the
// `a OR b` form the remote store now sends). The two sets are SEPARATE on
// purpose: seeding a lesson only into `searchEntries` proves the failure path
// QUERIES the store rather than post-filtering the injected/list set — that
// lesson is unreachable to the old path. remote.mjs calls restFetch for both.
function mockLessonServer(listEntries, searchEntries = listEntries) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      let out = listEntries;
      if (req.url && req.url.includes('/memories/search')) {
        let q = '';
        try { q = String(JSON.parse(body || '{}').q || '').toLowerCase(); } catch { q = ''; }
        const needles = q.split(/\s+or\s+/).filter(Boolean);
        out = needles.length
          ? searchEntries.filter((e) => needles.some((n) => `${e.key} ${e.value}`.toLowerCase().includes(n)))
          : searchEntries;
      }
      res.end(JSON.stringify({ entries: out, hasMore: false, nextCursor: null }));
    });
  });
}

test('PostToolUseFailure injects a RELEVANT lesson (found by querying, not post-filtering)', async () => {
  // The eslint lesson is seeded ONLY into the search set — NOT the list set the
  // SessionStart injection reads — so it is reachable only by querying the store.
  // Under the old post-filter-the-injected-set path this assertion would fail.
  const server = mockLessonServer(
    [{ key: 'unrelated', value: 'the sky is blue', tags: [] }],
    [{ key: 'eslint-flat-config', value: 'use eslint.config.js, the flat config; .eslintrc is ignored', tags: [] }],
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpProject = freshStateDir();
  try {
    const { stdout, code } = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'fi-1',
        cwd: tmpProject,
        tool_name: 'Bash',
        tool_response: { exit_code: 1, stderr: 'eslint: no configuration found (.eslintrc)' },
      },
      env: { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_ro_test' },
    });
    assert.equal(code, 0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /hit something like this before/); // the relevant-lesson block
    assert.match(ctx, /eslint-flat-config/); // reached only via the store query
    assert.doesNotMatch(ctx, /the sky is blue/); // the list-only lesson is never searched
    assert.match(ctx, /the last Bash call failed/); // the write-nudge still follows
  } finally {
    server.close();
  }
});

test('PostToolUseFailure with no matching lesson falls back to the nudge alone', async () => {
  const server = mockLessonServer([{ key: 'unrelated', value: 'the sky is blue', tags: [] }]);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpProject = freshStateDir();
  try {
    const { stdout, code } = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: {
        hook_event_name: 'PostToolUseFailure',
        session_id: 'fi-2',
        cwd: tmpProject,
        tool_name: 'Bash',
        tool_response: { exit_code: 1, stderr: 'kubernetes pod crashloopbackoff' },
      },
      env: { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_ro_test' },
    });
    assert.equal(code, 0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /hit something like this before/);
    assert.match(ctx, /the last Bash call failed/);
  } finally {
    server.close();
  }
});

test('PostToolUseFailure with no store configured still nudges (best-effort)', () => {
  // No MCP env → createStore returns null; the failure path must fall back to
  // the nudge alone and never crash.
  const tmpProject = freshStateDir();
  const { stdout, code } = runHook({
    adapter: 'claude',
    dir: tmpProject,
    input: {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'fi-3',
      cwd: tmpProject,
      tool_name: 'Edit',
      tool_response: { is_error: true, message: 'file not found' },
    },
    env: { LOREKIT_ENDPOINT: '', LOREKIT_MCP_URL: '', LOREKIT_TOKEN: '' },
  });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /the last Edit call failed/);
});

test('SessionStart reads lessons from the MCP server and injects them', async () => {
  // Mock LoreKit REST endpoint that returns one lesson for any scope.
  // remote.mjs now calls restFetch (REST API) for memory.list, not mcpCall.
  const server = http.createServer((req, res) => {
    req.on('data', () => {}); // drain body
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          entries: [{ key: 'lorekit-memory::demo', value: 'Demo lesson first line\nsecond', tags: [] }],
          hasMore: false,
          nextCursor: null,
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpProject = freshStateDir(); // no git remote, no .mcp.json → scope 'global', creds from env

  try {
    const { stdout, code } = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: { hook_event_name: 'SessionStart', session_id: 'read-1', cwd: tmpProject },
      env: {
        LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        LOREKIT_TOKEN: 'lk_ro_test',
      },
    });
    assert.equal(code, 0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /lorekit-memory::demo/);
    assert.match(ctx, /Demo lesson first line/);
    assert.doesNotMatch(ctx, /second/); // only the first line is summarized
  } finally {
    server.close();
  }
});

// `hooks.sessionStart.maxLessons` end-to-end, through a REAL `.lorekit.json`.
//
// The unit tests in `hooks.test.mjs` hand `maxLessons` straight to
// `fetchLessons`/`formatLessons`, so they would stay green in a build where
// `control.mjs` resolved the key perfectly and `hook.mjs` simply never passed it
// on. This is the test that goes red in that world: the only input is a config
// file on disk, and the assertion is on the block the real binary emitted.
//
// LOCAL mode, not the mock REST server the tests above use, because this
// assertion only needs a store the binary can read — and an on-disk one has no
// socket to fail on.
//
// HOW THE FETCH IS OBSERVED, since a local store's `list` reports no limit back:
// by ARITHMETIC on the candidate pool, which is the same thing the user
// experiences. Two scopes are seeded (`project::<tmpdir>` and `global`) with 90
// lessons each. At the default the read takes 25 per scope, so only 50
// candidates exist — the 40-line ceiling binds and 40 lines are injected. At
// `maxLessons: 80` an unchanged 25-row read could offer at most 50 candidates,
// so 80 injected lines are UNREACHABLE unless the fetch grew too. The second
// assertion therefore pins both halves of the change at once.
const SEEDED_PER_SCOPE = 90;

test('SessionStart: hooks.sessionStart.maxLessons raises the injected line count AND the fetch', async () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-maxlessons-'));
  const tmpHome = freshStateDir();
  const scope = deriveScope(tmpProject);
  const store = createTwoTierStore({ home: tmpHome, project: path.join(tmpProject, '.lorekit') });

  // Seeded across BOTH readOrder scopes so the default 40-line ceiling has more
  // than 25 candidates to bind against, and keyed per scope so cross-scope
  // precedence (first-seen wins) never collapses the pool.
  for (const [n, s] of scope.readOrder.entries()) {
    for (let i = 0; i < SEEDED_PER_SCOPE; i += 1) {
      // The `s${n}` prefix is load-bearing: identity is `scope::key`, and the
      // read resolves cross-scope precedence first-seen-wins, so reusing one key
      // set across both scopes would collapse the pool to a single scope's worth.
      // Written SEQUENTIALLY, not with a Promise.all, so `updated` is strictly
      // increasing — the store slices the newest N, and a batch that ties on
      // the timestamp would make "the newest 25" an arbitrary 25.
      // eslint-disable-next-line no-await-in-loop
      await store.write({ scope: s, key: `s${n}-seeded-${i}`, value: `lesson body ${i}` });
    }
  }

  const env = { LOREKIT_HOME: tmpHome, LOREKIT_MODE: 'local', LOREKIT_MCP_URL: '', LOREKIT_TOKEN: '' };
  const lessonLines = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext
    .split('\n').filter((l) => l.startsWith('- ')).length;
  const runWith = (config, sessionId) => {
    fs.writeFileSync(path.join(tmpProject, '.lorekit.json'), JSON.stringify(config));
    return runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: tmpProject },
      env,
    });
  };

  assert.ok(scope.readOrder.length >= 2, 'precondition — a temp dir reads at least project + global');

  // BASELINE. A budget big enough that only the LINE ceiling can bind, and no
  // `maxLessons` — so this pins the unconfigured behaviour exactly, and makes
  // the second run's difference attributable to the one key that changed.
  const base = await runWith({ 'hooks.sessionStart.maxChars': 20000 }, 'ml-default');
  assert.equal(base.code, 0);
  assert.equal(
    lessonLines(base.stdout),
    40,
    'unconfigured: the historic 40-line ceiling binds, from a 25-row-per-scope read',
  );

  // RAISED. Same store, same budget, one extra key.
  const raised = await runWith(
    { 'hooks.sessionStart.maxChars': 20000, 'hooks.sessionStart.maxLessons': 80 },
    'ml-raised',
  );
  assert.equal(raised.code, 0);
  assert.equal(
    lessonLines(raised.stdout),
    80,
    'raised: 80 lines is only reachable if the per-scope fetch grew past 25 as well',
  );

  // CLAMPED. An out-of-range value is honoured at the bound rather than
  // rejected, exactly as `maxChars`/`loopCap` behave.
  const clamped = await runWith(
    { 'hooks.sessionStart.maxChars': 20000, 'hooks.sessionStart.maxLessons': 4000 },
    'ml-clamped',
  );
  assert.equal(clamped.code, 0);
  // DERIVED from the scopes actually seeded, not the 180 that assumed exactly
  // two. The seed loop writes 90 to EVERY `readOrder` entry while the
  // precondition only requires two, so a checkout that resolves a third (a temp
  // dir inside a git repo picks up repo/branch) makes the pool 270, the ceiling
  // clamps at 200, and a hardcoded 180 reds for a reason that has nothing to do
  // with this feature. The read is also capped per scope, so the pool is bounded
  // by that, not by the 90 seeded.
  const pool = Math.min(SEEDED_PER_SCOPE, MAX_STORE_LIST_LIMIT) * scope.readOrder.length;
  assert.equal(
    lessonLines(clamped.stdout),
    Math.min(MAX_SESSION_START_MAX_LESSONS, pool),
    'clamped to the 200 ceiling, or to the seeded pool when that is smaller',
  );
});

// ── UserPromptSubmit: the per-turn relevance pull, as a PROCESS ──────────────
//
// `frameworks.test.mjs` covers this hook's SILENT cases and `hooks.test.mjs`
// covers its pure decisions against fake stores. Neither runs the real binary
// and asserts it EMITS, and for this hook that gap is worse than it sounds:
// silence is both the correct answer on a normal turn and the symptom of total
// failure. A build where the adapter stopped reading `input.prompt`, or where
// `createStore` came back null under the real control path, is silent forever
// and passes every existing assertion. These three tests are the ones that go
// red in that world.
//
// The mock is scope-AWARE, unlike `mockLessonServer` above: it filters the list
// route by the `?scope=` the store asks for and preserves each entry's own
// scope, exactly as `MEMORY_SELECT` does. That fidelity is load-bearing for the
// delta test — identity is `scope::key` (`lessonId`), so a mock that answered
// every scope with the same rows would hand SessionStart a lesson tagged with
// the most-specific scope and the search hit a different one, and the two would
// fail to match for a reason that exists only in the fixture.
function mockScopedLessonServer(entries) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      let out;
      if (req.url && req.url.includes('/memories/search')) {
        let q = '';
        let scopes = [];
        try {
          const parsed = JSON.parse(body || '{}');
          q = String(parsed.q || '').toLowerCase();
          scopes = Array.isArray(parsed.scopes) ? parsed.scopes : [];
        } catch { /* an unparseable body matches nothing, as the server would */ }
        const needles = q.split(/\s+or\s+/).filter(Boolean);
        out = entries.filter(
          (e) => (scopes.length === 0 || scopes.includes(e.scope))
            && needles.some((n) => `${e.key} ${e.value}`.toLowerCase().includes(n)),
        );
      } else {
        const asked = new URL(req.url, 'http://x').searchParams.get('scope');
        out = entries.filter((e) => e.scope === asked);
      }
      res.end(JSON.stringify({ entries: out, hasMore: false, nextCursor: null }));
    });
  });
}

test('UserPromptSubmit injects a lesson matching the prompt, in the host contract', async () => {
  // Seeded under `global`, which is always in `readOrder`, so the assertion does
  // not depend on what git says about the temp directory.
  const server = mockScopedLessonServer([
    { scope: 'global', key: 'eslint-flat-config', value: 'use eslint.config.js; .eslintrc is ignored', tags: [] },
    { scope: 'global', key: 'unrelated', value: 'the sky is blue', tags: [] },
  ]);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpProject = freshStateDir();
  try {
    const { stdout, code } = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'ups-emit',
        cwd: tmpProject,
        prompt: 'the eslint flat config keeps rejecting my rules',
      },
      env: { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_ro_test' },
    });
    assert.equal(code, 0);
    assert.notEqual(stdout, '', 'a substantive prompt with a matching lesson must emit');

    // The ENVELOPE, not just the text. The generic fixture loop in
    // frameworks.test.mjs early-returns on empty output, so no test that runs
    // the binary has ever checked this event's contract.
    const out = JSON.parse(stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /related to this/);          // the per-turn block, not SessionStart's
    assert.match(ctx, /eslint-flat-config/);       // matched on the prompt's own terms
    assert.doesNotMatch(ctx, /the sky is blue/);   // the relevance gate holds
  } finally {
    server.close();
  }
});

test('UserPromptSubmit never repeats a lesson SessionStart already injected', async () => {
  // The delta guarantee, and the ONLY test that can prove it: the shown-set is
  // written by one process and read by another, so an in-process test cannot
  // reach the part that breaks — `CLAUDE_PLUGIN_DATA` resolution and the
  // `session_id` threaded from stdin. Get either wrong and the hook re-injects
  // the session's opening set one lesson at a time, every turn, which is the
  // exact noise failure the design exists to prevent.
  // Long values on purpose: a rendered line costs its hook (capped at 80 chars),
  // so two short lessons would both fit any legal budget and the test could not
  // create the unseen-lesson state it depends on.
  const recent = new Date(Date.now() - 60_000).toISOString();
  const older = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const server = mockScopedLessonServer([
    {
      scope: 'global',
      key: 'migration-order',
      value: 'Always add the column before the backfill runs, or the backfill writes into a column that does not exist yet.',
      tags: [],
      // Explicit ranking inputs, because the injected ORDER decides which lesson
      // this test leaves unseen. Left to the defaults both entries tie and the
      // tiebreak is alphabetical — which would silently invert the fixture.
      updated_at: recent,
      seen_count: 12,
    },
    {
      scope: 'global',
      key: 'migration-locking',
      value: 'A backfill takes a table lock for its whole run, so batch it rather than issuing one statement.',
      tags: [],
      updated_at: older,
      seen_count: 1,
    },
  ]);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpProject = freshStateDir();
  const stateDir = freshStateDir(); // SHARED across both runs — that is the point
  const env = {
    LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
    LOREKIT_TOKEN: 'lk_ro_test',
    CLAUDE_PLUGIN_DATA: stateDir,
  };
  // Budget for one lesson line, so SessionStart renders the top-ranked lesson
  // alone and leaves the other genuinely unseen. Without it both are shown and
  // the second run is silent for the wrong reason — the test would pass while
  // proving nothing about the delta. There is no env override for this key, so
  // it goes on disk the way a user would set it.
  fs.writeFileSync(
    path.join(tmpProject, '.lorekit.json'),
    JSON.stringify({ 'hooks.sessionStart.maxChars': MIN_SESSION_START_MAX_CHARS }),
  );
  try {
    const first = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: { hook_event_name: 'SessionStart', session_id: 'ups-delta', cwd: tmpProject },
      env,
    });
    assert.equal(first.code, 0);
    const shown = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.match(shown, /migration-order/, 'precondition — SessionStart rendered this one');
    assert.doesNotMatch(shown, /migration-locking/, 'precondition — and left this one unseen');

    // Same session, same state dir: a prompt that matches BOTH lessons.
    const second = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'ups-delta',
        cwd: tmpProject,
        prompt: 'why does this migration backfill keep timing out',
      },
      env,
    });
    assert.equal(second.code, 0);
    assert.notEqual(second.stdout, '', 'the unseen lesson is news and must still surface');
    const ctx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /migration-locking/, 'the unseen match is injected');
    assert.doesNotMatch(ctx, /migration-order/, 'the already-shown one is not repeated');
  } finally {
    server.close();
  }
});

test('hooks.userPrompt: off silences the per-turn pull, store and match notwithstanding', async () => {
  // For a marketplace-plugin install this setting is the ONLY opt-out — the
  // plugin wires the event unconditionally, with no hook mode to downgrade — so
  // it is asserted through a real `.lorekit.json` on disk rather than through
  // `resolveControl` in isolation.
  const server = mockScopedLessonServer([
    { scope: 'global', key: 'eslint-flat-config', value: 'use eslint.config.js; .eslintrc is ignored', tags: [] },
  ]);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const tmpProject = freshStateDir();
  const input = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'ups-off',
    cwd: tmpProject,
    prompt: 'the eslint flat config keeps rejecting my rules',
  };
  const env = { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_ro_test' };
  try {
    // Anti-vacuity: prove this exact input DOES emit before switching it off,
    // or "silent" would only be evidence that the fixture never matched.
    const on = await runHookAsync({ adapter: 'claude', dir: tmpProject, input, env });
    assert.notEqual(on.stdout, '', 'precondition — this prompt emits while the hook is on');

    fs.writeFileSync(
      path.join(tmpProject, '.lorekit.json'),
      JSON.stringify({ 'hooks.userPrompt': 'off' }),
    );
    const off = await runHookAsync({
      adapter: 'claude',
      dir: tmpProject,
      input: { ...input, session_id: 'ups-off-2' }, // fresh session: not a delta skip
      env,
    });
    assert.equal(off.code, 0);
    assert.equal(off.stdout, '', 'hooks.userPrompt=off must silence it entirely');
  } finally {
    server.close();
  }
});
