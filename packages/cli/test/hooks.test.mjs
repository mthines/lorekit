import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFailure } from '../src/core/failure.mjs';
import {
  fetchLessons,
  formatLessons,
  retrospectiveNudge,
  failureNudge,
  failureQuery,
  relevantLessons,
  rankRelevant,
  relevantLessonsFromStore,
  formatRelevantLessons,
  writeConfirmation,
} from '../src/core/lessons.mjs';
import { resolvePrecedence, matchesQuery } from '../src/lessons-pure.mjs';
import { claude } from '../src/adapters/claude.mjs';
import { cursor } from '../src/adapters/cursor.mjs';
import { codex } from '../src/adapters/codex.mjs';

test('isFailure reads exit codes and error flags conservatively', () => {
  assert.equal(isFailure('Bash', { exit_code: 1 }), true);
  assert.equal(isFailure('Bash', { exit_code: 0 }), false);
  assert.equal(isFailure('Bash', { exitCode: 2 }), true);
  assert.equal(isFailure('X', { is_error: true }), true);
  assert.equal(isFailure('X', { status: 'error' }), true);
  assert.equal(isFailure('X', { status: 'success' }), false);
  assert.equal(isFailure('X', { interrupted: true }), false); // user abort, not a lesson
  assert.equal(isFailure('X', {}), false);
  assert.equal(isFailure('X', null), false);
});

test('formatLessons returns null when empty and a block otherwise', () => {
  assert.equal(formatLessons([], { repoScope: 'repo::a/b' }), null);
  const out = formatLessons(
    [{ key: 'k1', value: 'first line\nsecond', scope: 'repo::a/b' }],
    { repoScope: 'repo::a/b' },
  );
  assert.match(out, /k1/);
  assert.match(out, /repo::a\/b/);
  assert.match(out, /considerations, not rules/);
  assert.doesNotMatch(out, /second/); // only the first line is included
});

test('nudges name the write scope', () => {
  assert.match(retrospectiveNudge({ repoScope: 'repo::a/b' }), /memory\.write to repo::a\/b/);
  assert.match(failureNudge('Bash', { repoScope: null }), /memory\.write to global/);
});

// ── failureQuery (distil significant terms from a tool failure) ───────────────

test('failureQuery pulls significant terms from the tool name + error text', () => {
  const terms = failureQuery('Bash', { stderr: 'ENOENT: eslint config not found' });
  assert.ok(terms.includes('eslint'));
  assert.ok(terms.includes('enoent'));
  assert.ok(terms.includes('config'));
  // Generic/short words are dropped so a match stays meaningful.
  assert.ok(!terms.includes('not'));
  assert.ok(!terms.includes('error'));
});

test('failureQuery is total on any toolResponse shape (no throw)', () => {
  assert.deepEqual(failureQuery('X', null), []);
  assert.deepEqual(failureQuery('', {}), []);
  assert.deepEqual(failureQuery(null, undefined), []);
  // A raw string response is accepted directly.
  assert.ok(failureQuery('tool', 'permission denied writing lockfile').includes('permission'));
  // A nested object is stringified, not skipped.
  assert.ok(failureQuery('X', { error: { name: 'TimeoutException' } }).includes('timeoutexception'));
});

test('failureQuery de-duplicates and caps the term count', () => {
  const blob = Array.from({ length: 50 }, (_, i) => `token${i}`).join(' ');
  const terms = failureQuery('Bash', { stderr: `${blob} ${blob}` });
  assert.ok(terms.length <= 12);
  assert.equal(new Set(terms).size, terms.length); // no duplicates
});

test('failureQuery bounds the scanned input so a huge error blob cannot spike', () => {
  // A distinctive marker sits far past the scan bound (MAX_SCAN_CHARS=4096);
  // 'filler' dedups to a single term so the term cap does not mask the slice.
  const stderr = `inboundmarker ${'filler '.repeat(2000)}outboundmarker`;
  const terms = failureQuery('Bash', { stderr });
  assert.ok(terms.includes('inboundmarker')); // near the front — kept
  assert.ok(!terms.includes('outboundmarker')); // beyond the bound — dropped
});

// ── relevantLessons (filter injected lessons to ones the failure matches) ─────

const LESSONS = [
  { scope: 'repo::a/b', key: 'eslint-flat-config', value: 'use eslint.config.js not .eslintrc' },
  { scope: 'global', key: 'lockfile', value: 'run pnpm install to refresh the lockfile' },
  { scope: 'global', key: 'unrelated', value: 'the sky is blue' },
];

test('relevantLessons injects lessons matching a failure term, capped', () => {
  const hits = relevantLessons(LESSONS, ['eslint', 'lockfile']);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((l) => l.key), ['eslint-flat-config', 'lockfile']);
});

test('relevantLessons returns nothing when no term matches (nudge-only fallback)', () => {
  assert.deepEqual(relevantLessons(LESSONS, ['kubernetes']), []);
  assert.deepEqual(relevantLessons(LESSONS, []), []);
  assert.deepEqual(relevantLessons([], ['eslint']), []);
  assert.deepEqual(relevantLessons(null, ['eslint']), []);
});

test('relevantLessons respects the cap', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ scope: 'global', key: `k${i}`, value: 'eslint' }));
  assert.equal(relevantLessons(many, ['eslint'], 3).length, 3);
});

test('failureQuery + relevantLessons compose end to end', () => {
  const terms = failureQuery('Bash', { exit_code: 1, stderr: 'eslint: no configuration found' });
  const hits = relevantLessons(LESSONS, terms);
  assert.deepEqual(hits.map((l) => l.key), ['eslint-flat-config']);
});

test('formatRelevantLessons frames prior lessons, or null when empty', () => {
  assert.equal(formatRelevantLessons([]), null);
  const out = formatRelevantLessons([LESSONS[0]]);
  assert.match(out, /hit something like this before/);
  assert.match(out, /eslint-flat-config/);
  assert.match(out, /repo::a\/b/);
  assert.match(out, /considerations, not rules/);
});

// ── rankRelevant (rank/dedupe store-search hits across terms) ─────────────────

const READ_ORDER = ['repo::a/b', 'global'];

test('rankRelevant ranks a lesson matched by more terms first', () => {
  const two = { scope: 'global', key: 'two', value: 'x' };
  const one = { scope: 'global', key: 'one', value: 'y' };
  // `two` appears in two terms' results, `one` in a single term's.
  const ranked = rankRelevant([[two, one], [two]], READ_ORDER);
  assert.deepEqual(ranked.map((l) => l.key), ['two', 'one']);
});

test('rankRelevant de-duplicates by scope::key and tie-breaks toward the more specific scope', () => {
  const repo = { scope: 'repo::a/b', key: 'k', value: 'r' };
  const glob = { scope: 'global', key: 'g', value: 'g' };
  // Both matched by exactly one term; the repo scope precedes global in readOrder.
  const ranked = rankRelevant([[glob, repo], [repo, glob]], READ_ORDER);
  assert.equal(ranked.length, 2); // repo+glob appear once each despite two terms
  assert.deepEqual(ranked.map((l) => l.key), ['k', 'g']);
});

test('rankRelevant is total on junk input and respects the cap', () => {
  assert.deepEqual(rankRelevant(null), []);
  assert.deepEqual(rankRelevant([null, undefined, 'nope']), []);
  assert.deepEqual(rankRelevant([[{ value: 'no key' }]]), []); // keyless entries skipped
  const many = Array.from({ length: 6 }, (_, i) => [{ scope: 'global', key: `k${i}`, value: 'v' }]);
  assert.equal(rankRelevant(many, READ_ORDER, 3).length, 3);
});

// ── relevantLessonsFromStore (QUERY the store, not post-filter the injected set) ─

// A fake store whose search() matches key/value against the single query term,
// across ALL scopes it holds — standing in for a store whose corpus is larger
// than any one SessionStart injection.
function searchStore(corpus) {
  return {
    async search({ q, scopes }) {
      const needle = String(q || '').toLowerCase();
      const entries = corpus.filter(
        (e) => scopes.includes(e.scope) && `${e.key} ${e.value}`.toLowerCase().includes(needle),
      );
      return { ok: true, entries };
    },
  };
}

const SCOPE = { readOrder: ['repo::a/b', 'global'] };

test('relevantLessonsFromStore retrieves a matching lesson the injected set would miss', async () => {
  // This lesson is in a scope in readOrder but is only discoverable by querying —
  // the point of the change vs. post-filtering the pre-injected lessons.
  const corpus = [
    { scope: 'global', key: 'econnrefused', value: 'retry the connection with backoff' },
    { scope: 'global', key: 'unrelated', value: 'the sky is blue' },
  ];
  const hits = await relevantLessonsFromStore(searchStore(corpus), SCOPE, ['connection', 'backoff']);
  assert.deepEqual(hits.map((l) => l.key), ['econnrefused']);
});

test('relevantLessonsFromStore returns [] when nothing matches (nudge-only fallback)', async () => {
  const corpus = [{ scope: 'global', key: 'unrelated', value: 'the sky is blue' }];
  assert.deepEqual(await relevantLessonsFromStore(searchStore(corpus), SCOPE, ['kubernetes']), []);
});

test('relevantLessonsFromStore is best-effort: a throwing/absent store never rejects', async () => {
  const throwing = { async search() { throw new Error('network down'); } };
  assert.deepEqual(await relevantLessonsFromStore(throwing, SCOPE, ['x']), []);
  assert.deepEqual(await relevantLessonsFromStore(null, SCOPE, ['x']), []);
  assert.deepEqual(await relevantLessonsFromStore({}, SCOPE, ['x']), []); // no search()
});

test('relevantLessonsFromStore guards empty terms and scopes without querying', async () => {
  let called = false;
  const spy = { async search() { called = true; return { ok: true, entries: [] }; } };
  assert.deepEqual(await relevantLessonsFromStore(spy, SCOPE, []), []);
  assert.deepEqual(await relevantLessonsFromStore(spy, { readOrder: [] }, ['x']), []);
  assert.equal(called, false);
});

// ── fetchLessons resolves precedence via the shared resolvePrecedence ─────────

// A minimal fake store: returns the seeded entries per scope, and can be told to
// fail a scope's read (best-effort skip) — no network, no filesystem.
function fakeStore(byScope, { failScopes = [] } = {}) {
  return {
    async list({ scope }) {
      if (failScopes.includes(scope)) return { ok: false };
      return { ok: true, entries: byScope[scope] || [] };
    },
  };
}

test('fetchLessons keeps the most-specific value per key — same as resolvePrecedence', async () => {
  // deriveScope on this repo yields project → branch? → repo → global; seed the
  // duplicate key at every possible scope so whichever leads wins deterministically.
  const shared = (scope, v) => ({ scope, key: 'shared', value: v });
  const byScope = {};
  // Build groups in readOrder to compute the expected winners independently.
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  scope.readOrder.forEach((s, i) => {
    byScope[s] = [shared(s, `body-${i}`), { scope: s, key: `only-${i}`, value: `u${i}` }];
  });
  const { lessons } = await fetchLessons(fakeStore(byScope), process.cwd());

  // Expected: resolvePrecedence over the same groups, taking the winners.
  const groups = scope.readOrder.map((s) => ({ scope: s, error: null, entries: byScope[s] }));
  const { groups: resolved } = resolvePrecedence({ groups });
  const expected = [];
  for (const g of resolved) for (const e of g.entries) if (e.winning) expected.push(e);

  assert.deepEqual(
    lessons.map((l) => `${l.scope}:${l.key}`),
    expected.map((l) => `${l.scope}:${l.key}`),
  );
  // The single `shared` winner is the FIRST (most-specific) scope in readOrder.
  const sharedWinners = lessons.filter((l) => l.key === 'shared');
  assert.equal(sharedWinners.length, 1);
  assert.equal(sharedWinners[0].scope, scope.readOrder[0]);
});

test('fetchLessons is best-effort: a failed scope read is skipped, not thrown', async () => {
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const first = scope.readOrder[0];
  const last = scope.readOrder[scope.readOrder.length - 1];
  const store = fakeStore({ [last]: [{ scope: last, key: 'survivor', value: 'v' }] }, { failScopes: [first] });
  const { lessons } = await fetchLessons(store, process.cwd());
  assert.deepEqual(lessons.map((l) => l.key), ['survivor']);
});

test('fetchLessons caps at MAX_LESSONS (15)', async () => {
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const many = Array.from({ length: 30 }, (_, i) => ({ scope: scope.readOrder[0], key: `k${i}`, value: 'v' }));
  const { lessons } = await fetchLessons(fakeStore({ [scope.readOrder[0]]: many }), process.cwd());
  assert.equal(lessons.length, 15);
});

test('matchesQuery re-export from lessons-pure matches the search matcher', () => {
  assert.equal(matchesQuery({ key: 'k', value: 'eslint' }, 'ESLINT'), true);
  assert.equal(matchesQuery({ key: 'k', value: 'v' }, 'a.*b'), false); // literal, not regex
});

test('adapter event → intent mapping', () => {
  assert.equal(claude.intentFor('SessionStart'), 'read');
  assert.equal(claude.intentFor('PostToolUse'), 'confirm');
  assert.equal(claude.intentFor('PostToolUseFailure'), 'failure');
  assert.equal(claude.intentFor('Stop'), 'retrospective');
  assert.equal(claude.intentFor('Whatever'), 'noop');

  assert.equal(codex.intentFor('SessionStart'), 'read');
  assert.equal(codex.intentFor('Stop'), 'retrospective');

  assert.equal(cursor.intentFor('beforeSubmitPrompt'), 'read');
  assert.equal(cursor.intentFor('stop'), 'retrospective');
  assert.equal(cursor.intentFor('beforeShellExecution'), 'noop');
});

test('adapters emit their framework-specific output shape', () => {
  assert.deepEqual(JSON.parse(claude.emit('Stop', 'hi')), {
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'hi' },
  });
  assert.deepEqual(JSON.parse(codex.emit('SessionStart', 'hi')), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' },
  });
  assert.deepEqual(JSON.parse(cursor.emit('stop', 'hi')), { followup_message: 'hi' });
});

test('adapters normalize their native stdin fields', () => {
  const c = claude.parse({
    cwd: '/p',
    session_id: 's',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_response: { exit_code: 1 },
  });
  assert.equal(c.cwd, '/p');
  assert.equal(c.sessionId, 's');
  assert.equal(c.toolName, 'Bash');
  assert.deepEqual(c.toolInput, { command: 'npm test' });

  const cu = cursor.parse({ generation_id: 'g', workspace_roots: ['/w'] });
  assert.equal(cu.sessionId, 'g');
  assert.equal(cu.cwd, '/w');
});

// ── scope.defaults + tags.default in nudge text ───────────────────────────────
// (retrospectiveNudge, failureNudge already imported above)

// Build a minimal scope object matching deriveScope's shape.
function fakeScope(overrides = {}) {
  return { repoScope: 'repo::owner/repo', ...overrides };
}

test('retrospectiveNudge includes tags hint when tagsDefault is set', () => {
  const scope = fakeScope();
  const control = { tagsDefault: ['team', 'loop::aw-lessons'], scopeDefaults: null };
  const text = retrospectiveNudge(scope, control);
  assert.match(text, /Include tags/);
  assert.match(text, /"team"/);
  assert.match(text, /"loop::aw-lessons"/);
});

test('retrospectiveNudge includes no tags hint when tagsDefault is empty', () => {
  const scope = fakeScope();
  const control = { tagsDefault: [], scopeDefaults: null };
  const text = retrospectiveNudge(scope, control);
  assert.doesNotMatch(text, /Include tags/);
});

test('failureNudge includes tags from scope.defaults when scope matches', () => {
  const scope = fakeScope();
  const control = {
    tagsDefault: [],
    scopeDefaults: { 'repo::owner/repo': { tags: ['project::lorekit'] } },
  };
  const text = failureNudge('Bash', scope, control);
  assert.match(text, /Include tags/);
  assert.match(text, /"project::lorekit"/);
});

test('failureNudge adds no tags hint when scope does not match any defaults prefix', () => {
  const scope = fakeScope({ repoScope: 'repo::other/repo' });
  const control = {
    tagsDefault: [],
    scopeDefaults: { 'repo::owner/': { tags: ['team'] } },
  };
  const text = failureNudge('Bash', scope, control);
  assert.doesNotMatch(text, /Include tags/);
});

test('retrospectiveNudge and failureNudge work without control arg (backward compat)', () => {
  const scope = fakeScope();
  assert.doesNotThrow(() => retrospectiveNudge(scope));
  assert.doesNotThrow(() => failureNudge('Bash', scope));
});

// ── hooks.instructions — per-event custom instruction appended to hook output ──

test('formatLessons appends instruction when provided', () => {
  const out = formatLessons(
    [{ key: 'k1', value: 'some lesson', scope: 'repo::a/b' }],
    { repoScope: 'repo::a/b' },
    { instruction: 'Focus on migration safety.' },
  );
  assert.match(out, /Project instruction:/);
  assert.match(out, /Focus on migration safety/);
});

test('formatLessons with empty lessons and an instruction emits header + instruction', () => {
  const out = formatLessons([], { repoScope: 'repo::a/b' }, { instruction: 'Use strict mode.' });
  assert.ok(out !== null, 'should not return null when instruction is set');
  assert.match(out, /Project instruction:/);
  assert.match(out, /Use strict mode/);
});

test('formatLessons with no instruction still returns null for empty lessons', () => {
  assert.equal(formatLessons([], { repoScope: 'repo::a/b' }), null);
  assert.equal(formatLessons([], { repoScope: 'repo::a/b' }, {}), null);
  assert.equal(formatLessons([], { repoScope: 'repo::a/b' }, { instruction: null }), null);
});

test('retrospectiveNudge appends instruction from control.hooksInstructions.Stop', () => {
  const scope = fakeScope();
  const control = {
    tagsDefault: [],
    scopeDefaults: null,
    hooksInstructions: { Stop: 'Always record the commands you ran.' },
  };
  const text = retrospectiveNudge(scope, control);
  assert.match(text, /Project instruction:/);
  assert.match(text, /Always record the commands/);
});

test('failureNudge appends instruction from control.hooksInstructions.PostToolUseFailure', () => {
  const scope = fakeScope();
  const control = {
    tagsDefault: [],
    scopeDefaults: null,
    hooksInstructions: { PostToolUseFailure: 'Include the exit code in the lesson.' },
  };
  const text = failureNudge('Bash', scope, control);
  assert.match(text, /Project instruction:/);
  assert.match(text, /Include the exit code/);
});

test('nudges emit no instruction when hooksInstructions is missing or null for that event', () => {
  const scope = fakeScope();
  const controlNoInstr = { tagsDefault: [], scopeDefaults: null, hooksInstructions: {} };
  assert.doesNotMatch(retrospectiveNudge(scope, controlNoInstr), /Project instruction/);
  assert.doesNotMatch(failureNudge('Bash', scope, controlNoInstr), /Project instruction/);
  assert.doesNotMatch(retrospectiveNudge(scope, { tagsDefault: [], scopeDefaults: null }), /Project instruction/);
});

// The scope-encoding contract these three cases used to assert through the
// `loreUrl` pass-through is covered directly on `loreScopeUrl` in
// `test/deeplink.test.mjs` (the bare URL for null/empty, and the JSON-encoded
// `global` / `repo::owner/repo` filters).

// ── writeConfirmation ─────────────────────────────────────────────────────────

test('writeConfirmation deep-links to the exact lesson (scope + lesson params)', () => {
  const scope = fakeScope({ repoScope: 'repo::owner/repo' });
  const text = writeConfirmation(scope, 'my-lesson-key');
  assert.match(text, /memory saved to repo::owner\/repo/);
  assert.match(text, /my-lesson-key/);
  assert.match(text, /lorekit\.io\/lore/);
  // Opens the detail sheet: the `lesson` param plus the `scope` filter (so the
  // lesson is in the fetched set). No `q=` search fallback anymore.
  assert.match(text, /lesson=/);
  assert.match(text, /scope=/);
  assert.doesNotMatch(text, /q=/);
});

test('writeConfirmation links to the scope filter when the key is null', () => {
  const scope = fakeScope({ repoScope: 'repo::owner/repo' });
  const text = writeConfirmation(scope, null);
  assert.match(text, /memory saved to repo::owner\/repo/);
  assert.doesNotMatch(text, /q=/);
  assert.doesNotMatch(text, /lesson=/);
  assert.match(text, /scope=/);
  assert.match(text, /lorekit\.io\/lore/);
});

test('writeConfirmation falls back to global scope', () => {
  const text = writeConfirmation({ repoScope: null }, 'k');
  assert.match(text, /memory saved to global/);
  assert.match(text, /lorekit\.io\/lore/);
});

test('writeConfirmation links to the ACTUAL write scope, not the cwd repo scope', () => {
  // A global write under a repo cwd must deep-link to the global lesson — the
  // old repoScope-based ref pointed at a lesson that does not exist.
  const scope = fakeScope({ repoScope: 'repo::owner/repo' });
  const text = writeConfirmation(scope, 'k', 'global');
  assert.match(text, /memory saved to global/);
  assert.doesNotMatch(text, /memory saved to repo::owner\/repo/);
  // The lesson ref is scoped to global, JSON-encoded.
  assert.match(text, /scope=%22global%22/);
  assert.match(text, /lesson=%7B%22scope%22%3A%22global%22/);
});

// ── retrospectiveNudge is a terse one-liner (no lore URL) ─────────────────────

test('retrospectiveNudge is a single line and targets the write scope', () => {
  const scope = fakeScope({ repoScope: 'repo::owner/repo' });
  const text = retrospectiveNudge(scope);
  assert.match(text, /memory\.write to repo::owner\/repo/);
  // The deep-link lives on the write CONFIRMATION now, not the nudge — the
  // retrospective stays terse.
  assert.doesNotMatch(text, /lorekit\.io\/lore/);
  assert.doesNotMatch(text, /View lore/);
  assert.equal(text.split('\n').length, 1, 'nudge should be one line');
});

test('retrospectiveNudge falls back to the global scope when there is no repo', () => {
  const text = retrospectiveNudge({ repoScope: null });
  assert.match(text, /memory\.write to global/);
});

test('retrospectiveNudge names detected friction reasons when provided', () => {
  const scope = fakeScope({ repoScope: 'repo::owner/repo' });
  const both = retrospectiveNudge(scope, null, { reasons: ['failure', 'stuck-loop'] });
  assert.match(both, /this session hit/);
  assert.match(both, /a failed tool call and a repeated retry/);

  const one = retrospectiveNudge(scope, null, { reasons: ['failure'] });
  assert.match(one, /this session hit a failed tool call/);
  assert.doesNotMatch(one, / and /);

  // No reasons → the generic prompt (the `always`/undetectable path).
  const generic = retrospectiveNudge(scope, null, { reasons: [] });
  assert.match(generic, /any friction worth remembering/);
});

// ── claude.isLoreWrite ────────────────────────────────────────────────────────

test('isLoreWrite detects a successful memory write by tool name suffix + response id', () => {
  assert.equal(claude.isLoreWrite('mcp__lorekit__memory_write', { id: 'abc-123', created_at: '2026-01-01' }), true);
  assert.equal(claude.isLoreWrite('mcp__other_server__memory_write', { id: 'abc' }), true);
});

test('isLoreWrite rejects non-write tool names', () => {
  assert.equal(claude.isLoreWrite('Bash', { id: 'abc' }), false);
  assert.equal(claude.isLoreWrite('mcp__lorekit__memory_read', { id: 'abc' }), false);
});

test('isLoreWrite rejects responses without a string id (failed or non-write responses)', () => {
  assert.equal(claude.isLoreWrite('mcp__lorekit__memory_write', null), false);
  assert.equal(claude.isLoreWrite('mcp__lorekit__memory_write', {}), false);
  assert.equal(claude.isLoreWrite('mcp__lorekit__memory_write', { id: 123 }), false);
});

test('isLoreWrite handles null/undefined tool name safely', () => {
  assert.equal(claude.isLoreWrite(null, { id: 'abc' }), false);
  assert.equal(claude.isLoreWrite(undefined, { id: 'abc' }), false);
});

// ── claude.parse — toolInput field ────────────────────────────────────────────

test('claude.parse captures tool_input so the confirm branch can read the key', () => {
  const parsed = claude.parse({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__lorekit__memory_write',
    tool_input: { scope: 'repo::a/b', key: 'my-lesson', value: 'body' },
    tool_response: { id: 'abc-123', created_at: '2026-01-01T00:00:00Z' },
  });
  assert.equal(parsed.toolName, 'mcp__lorekit__memory_write');
  assert.deepEqual(parsed.toolInput, { scope: 'repo::a/b', key: 'my-lesson', value: 'body' });
  assert.deepEqual(parsed.toolResponse, { id: 'abc-123', created_at: '2026-01-01T00:00:00Z' });
});

test('claude.parse defaults toolInput to null when absent', () => {
  const parsed = claude.parse({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(parsed.toolInput, null);
});


// ── ttl.default / scope.defaults ttl_days in nudge text ───────────────────────
// A hook never writes a memory — it emits text and the agent writes later, over
// MCP. Advising the number is the only lever it has, so these assert the advice
// is present, correct, and silent when unconfigured.

test('retrospectiveNudge advises the configured ttl_days', () => {
  const control = { tagsDefault: [], scopeDefaults: null, ttlDefault: 90 };
  const text = retrospectiveNudge(fakeScope(), control);
  assert.match(text, /Set ttl_days: 90/);
});

test('failureNudge advises the scope-specific ttl_days over ttl.default', () => {
  const control = {
    tagsDefault: [],
    ttlDefault: 90,
    scopeDefaults: { 'repo::owner/repo': { ttl_days: 14 } },
  };
  const text = failureNudge('Bash', fakeScope(), control);
  assert.match(text, /Set ttl_days: 14/);
  assert.doesNotMatch(text, /Set ttl_days: 90/);
});

test('nudges advise no ttl_days when the scope is configured permanent', () => {
  const control = {
    tagsDefault: [],
    ttlDefault: 90,
    scopeDefaults: { 'repo::owner/repo': { ttl_days: null } },
  };
  assert.doesNotMatch(failureNudge('Bash', fakeScope(), control), /ttl_days/);
});

test('nudges mention no ttl_days when nothing is configured', () => {
  const control = { tagsDefault: [], scopeDefaults: null };
  assert.doesNotMatch(retrospectiveNudge(fakeScope(), control), /ttl_days/);
  assert.doesNotMatch(failureNudge('Bash', fakeScope(), control), /ttl_days/);
});

test('nudges combine the tags hint and the ttl hint', () => {
  const control = { tagsDefault: ['team'], scopeDefaults: null, ttlDefault: 30 };
  const text = retrospectiveNudge(fakeScope(), control);
  assert.match(text, /Include tags/);
  assert.match(text, /Set ttl_days: 30/);
});

test('an invalid configured ttl produces no hint rather than a broken one', () => {
  const control = { tagsDefault: [], scopeDefaults: null, ttlDefault: 900 };
  assert.doesNotMatch(retrospectiveNudge(fakeScope(), control), /ttl_days/);
});
