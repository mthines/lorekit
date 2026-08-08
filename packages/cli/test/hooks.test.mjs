import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFailure } from '../src/core/failure.mjs';
import {
  fetchLessons,
  formatLessons,
  retrospectiveNudge,
  failureNudge,
  failureQuery,
  dedupeRelevant,
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

// ── formatRelevantLessons (frame the failure-relevance block) ─────────────────

const LESSONS = [
  { scope: 'repo::a/b', key: 'eslint-flat-config', value: 'use eslint.config.js not .eslintrc' },
  { scope: 'global', key: 'lockfile', value: 'run pnpm install to refresh the lockfile' },
  { scope: 'global', key: 'unrelated', value: 'the sky is blue' },
];

test('formatRelevantLessons frames prior lessons, or null when empty', () => {
  assert.equal(formatRelevantLessons([]), null);
  const out = formatRelevantLessons([LESSONS[0]]);
  assert.match(out, /hit something like this before/);
  assert.match(out, /eslint-flat-config/);
  assert.match(out, /repo::a\/b/);
  assert.match(out, /considerations, not rules/);
});

// ── dedupeRelevant (dedupe + cap store-search hits, preserving store order) ────

test('dedupeRelevant preserves store order and de-duplicates by scope::key', () => {
  const a = { scope: 'repo::a/b', key: 'k', value: 'r' };
  const aDup = { scope: 'repo::a/b', key: 'k', value: 'r (from another tier)' };
  const b = { scope: 'global', key: 'g', value: 'g' };
  const out = dedupeRelevant([a, b, aDup]);
  assert.deepEqual(out.map((l) => l.key), ['k', 'g']); // order kept, dup dropped
  assert.equal(out[0].value, 'r'); // first-seen wins
});

test('dedupeRelevant is total on junk input and respects the cap', () => {
  assert.deepEqual(dedupeRelevant(null), []);
  assert.deepEqual(dedupeRelevant([null, undefined, 'nope']), []);
  assert.deepEqual(dedupeRelevant([{ value: 'no key' }]), []); // keyless entries skipped
  const many = Array.from({ length: 6 }, (_, i) => ({ scope: 'global', key: `k${i}`, value: 'v' }));
  assert.equal(dedupeRelevant(many, 3).length, 3);
  // The cap is checked BEFORE the push, so the boundary value really is empty.
  assert.deepEqual(dedupeRelevant(many, 0), []);
  assert.deepEqual(dedupeRelevant(many, -1), []);
});

// ── relevantLessonsFromStore (QUERY the store, not post-filter the injected set) ─

// A fake store whose search() OR-matches key/value against the query — a single
// string OR a list of terms — across ALL scopes it holds, standing in for a
// store whose corpus is larger than any one SessionStart injection. It records
// every call so a test can assert the seam queries ONCE, not once per term.
function searchStore(corpus) {
  const calls = [];
  const store = {
    calls,
    async search({ q, scopes }) {
      calls.push(q);
      const needles = (Array.isArray(q) ? q : [q]).map((n) => String(n || '').toLowerCase()).filter(Boolean);
      const entries = corpus.filter(
        (e) => scopes.includes(e.scope)
          && needles.some((n) => `${e.key} ${e.value}`.toLowerCase().includes(n)),
      );
      return { ok: true, entries };
    },
  };
  return store;
}

const SCOPE = { readOrder: ['repo::a/b', 'global'] };

test('relevantLessonsFromStore issues ONE search carrying all terms (not one per term)', async () => {
  const store = searchStore([{ scope: 'global', key: 'k', value: 'econnrefused' }]);
  await relevantLessonsFromStore(store, SCOPE, ['econnrefused', 'timeout', 'retry']);
  assert.equal(store.calls.length, 1); // one pass, not three
  assert.deepEqual(store.calls[0], ['econnrefused', 'timeout', 'retry']); // all terms in one query
});

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

  // MEMBERSHIP, not order. `fetchLessons` now ranks the winners before capping,
  // so the injected ORDER is the scorer's; what precedence owns — and what this
  // test is about — is which entries are in the set at all. Compared as sorted
  // sets so a ranking change can never silently turn into a membership change.
  assert.deepEqual(
    lessons.map((l) => `${l.scope}:${l.key}`).sort(),
    expected.map((l) => `${l.scope}:${l.key}`).sort(),
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

// ── fetchLessons ranks the winners before the cap ────────────────────────────
// The observed failure this fixes: on an active repo the newest cluster of
// writes is one task's iteration log, and a recency-ordered cap handed that
// cluster every slot — ~13 of 15 — evicting the lessons that had been
// re-learned all month.

const RANK_NOW = Date.parse('2026-08-01T00:00:00.000Z');
const rankDaysAgo = (n) => new Date(RANK_NOW - n * 86400000).toISOString();

// A lesson shaped the way the store layer now hands them over.
function seeded(scope, key, { days = 0, seen = 1, value = 'v' } = {}) {
  return { scope, key, value, seenCount: seen, updatedAt: rankDaysAgo(days) };
}

test('fetchLessons ranked — the injected set is ordered by score, not by group order', async () => {
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const s = scope.readOrder[0];

  // Seeded in the WORST possible order for a recency-or-insertion sort: the
  // best lesson is last.
  const entries = [
    seeded(s, 'stale-oneoff', { days: 90, seen: 1 }),
    seeded(s, 'fresh-oneoff', { days: 0, seen: 1 }),
    seeded(s, 'recurring', { days: 2, seen: 20 }),
  ];
  const { lessons } = await fetchLessons(fakeStore({ [s]: entries }), process.cwd(), { now: RANK_NOW });

  assert.equal(lessons[0].key, 'recurring');
  assert.equal(lessons[lessons.length - 1].key, 'stale-oneoff');
});

test('fetchLessons salience top slots — a recurring lesson survives a flood of newer one-offs', async () => {
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const s = scope.readOrder[0];

  // The reported shape: one task's iteration log, written today, plus the
  // hard-won lesson from last week. Under the old recency cap the flood took
  // all 15 slots and `hard-won` was never injected.
  const flood = Array.from({ length: 30 }, (_, i) => seeded(s, `iteration-${i}`, { days: 0, seen: 1 }));
  const entries = [...flood, seeded(s, 'hard-won', { days: 7, seen: 12 })];

  const { lessons } = await fetchLessons(fakeStore({ [s]: entries }), process.cwd(), { now: RANK_NOW });

  assert.equal(lessons.length, 15, 'still capped');
  assert.equal(lessons[0].key, 'hard-won', 'and it is now the FIRST thing the agent reads');

  // The regression guard: prove the old ordering would have dropped it.
  const byRecencyThenInsertion = entries.slice(0, 15).map((e) => e.key);
  assert.ok(
    !byRecencyThenInsertion.includes('hard-won'),
    'precondition — the pre-ranking cap did not include it',
  );
});

test('fetchLessons ranked — with nothing recurring, the order is still recency', async () => {
  // Salience must not invent a preference where there is no recurrence signal:
  // a store of pure one-offs should behave exactly as it always did.
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const s = scope.readOrder[0];
  const entries = [
    seeded(s, 'c', { days: 30 }),
    seeded(s, 'a', { days: 1 }),
    seeded(s, 'b', { days: 10 }),
  ];
  const { lessons } = await fetchLessons(fakeStore({ [s]: entries }), process.cwd(), { now: RANK_NOW });
  assert.deepEqual(lessons.map((l) => l.key), ['a', 'b', 'c']);
});

test('precedence unchanged — a shadowed lesson cannot be ranked back into the set', async () => {
  // The load-bearing property of running the scorer on the WINNERS only. The
  // global copy is made maximally attractive (very recent, highly recurring)
  // and the project copy maximally unattractive; precedence must still win,
  // because which copy of a key survives is a correctness rule and not a
  // preference the scorer gets a vote on.
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  if (scope.readOrder.length < 2) return; // needs at least two scopes to shadow
  const [narrow] = scope.readOrder;
  const broad = scope.readOrder[scope.readOrder.length - 1];

  const { lessons } = await fetchLessons(
    fakeStore({
      [narrow]: [seeded(narrow, 'shared', { days: 400, seen: 1, value: 'narrow wins' })],
      [broad]: [seeded(broad, 'shared', { days: 0, seen: 99, value: 'broad must lose' })],
    }),
    process.cwd(),
    { now: RANK_NOW },
  );

  const shared = lessons.filter((l) => l.key === 'shared');
  assert.equal(shared.length, 1, 'still exactly one copy of the key');
  assert.equal(shared[0].scope, narrow, 'the most-specific scope still wins');
  assert.equal(shared[0].value, 'narrow wins');
});

test('fetchLessons ranked — an entry with no ranking fields is still injected', async () => {
  // A store that predates the seenCount/updatedAt projection (or a scope read
  // that returned bare rows) must not vanish from the injection just because it
  // scores zero — the hook is best-effort and a lesson is better than nothing.
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const s = scope.readOrder[0];
  const { lessons } = await fetchLessons(
    fakeStore({ [s]: [{ scope: s, key: 'bare', value: 'v' }, seeded(s, 'scored', { days: 1, seen: 5 })] }),
    process.cwd(),
    { now: RANK_NOW },
  );
  assert.deepEqual(lessons.map((l) => l.key), ['scored', 'bare']);
});

test('formatLessons index shape — ranking did not change what is emitted', async () => {
  // PR-3 is an ORDERING change. The rendered block is still the compact index:
  // one line per lesson, `scope::key` plus a short hook, bodies a memory.read
  // away. A change here would be a change to the injected contract.
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const s = scope.readOrder[0];
  const { lessons } = await fetchLessons(
    fakeStore({
      [s]: [
        seeded(s, 'recurring', { days: 2, seen: 9, value: 'Always re-read the migration first.' }),
        seeded(s, 'one-off', { days: 0, seen: 1, value: 'A single sighting.' }),
      ],
    }),
    process.cwd(),
    { now: RANK_NOW },
  );
  const text = formatLessons(lessons, scope);
  const bullets = text.split('\n').filter((l) => l.startsWith('- ('));

  // Still ONE line per lesson, still `- (scope) key — hook`.
  assert.equal(bullets.length, 2);
  assert.match(bullets[0], /^- \(.+\) recurring — Always re-read the migration first\.$/);
  assert.match(bullets[1], /^- \(.+\) one-off — A single sighting\.$/);
  assert.match(text.split('\n')[0], /^LoreKit: 2 memories loaded ·/);
  // The score is an internal ordering device — it must not leak into the
  // agent-facing text.
  assert.ok(!/score/i.test(text), 'the score is not rendered');
});
