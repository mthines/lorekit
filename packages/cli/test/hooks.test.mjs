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
  renderScopeMap,
  promptQuery,
  isSubstantivePrompt,
  promptLessonsFromStore,
  formatPromptLessons,
  lessonId,
  SCOPE_READ_LIMIT,
} from '../src/core/lessons.mjs';
import { resolvePrecedence, matchesQuery } from '../src/lessons-pure.mjs';
import { deriveScope } from '../src/scope.mjs';
import { claude } from '../src/adapters/claude.mjs';
import { cursor } from '../src/adapters/cursor.mjs';
import { codex } from '../src/adapters/codex.mjs';

// `deriveScope` shells out to git three times (~0.8s here), and it is the real
// scope of this checkout, so it is the same value for every test in the file.
// Resolved ONCE at module level: the tests that need it were each paying for
// their own call on top of the one `fetchLessons` makes internally, which is
// the bulk of this file's runtime. Nothing in `core/lessons.mjs` ever sees this
// object — `fetchLessons` derives its own scope from the `cwd` it is handed,
// and `relevantLessonsFromStore` is only ever called here with the synthetic
// `SCOPE` fixture — so the sharers are the test bodies in this file. Shared
// safely because each of them only reads `scope.readOrder`; none reorders or
// appends to it. Frozen so that stays an enforced invariant rather than a
// promise in a comment — `readOrder` too, since `Object.freeze` is shallow and
// the array is the thing a test could reorder or append to.
const REAL_SCOPE = (() => {
  const scope = deriveScope(process.cwd());
  Object.freeze(scope.readOrder);
  return Object.freeze(scope);
})();

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
    // Mirrors the real read in BOTH of its steps, because either one alone
    // lets a fixture seed a group production could never return:
    //   1. SORT newest-first — `store/local.mjs:75` sorts on `updated` before
    //      it slices, and the remote route answers in the same order. Slicing
    //      in fixture order would keep an arbitrary 25, not the newest 25.
    //   2. SLICE to `limit` — `store/local.mjs:76`, `store/remote.mjs:68`.
    // The sort is unconditional, like the real one: gating it on `limit` would
    // re-diverge for every no-limit caller. Entries are copied first, so a read
    // never reorders a fixture another test is holding. Rows with no timestamp
    // compare equal and keep their seeded order (`sort` is stable), so the
    // fixtures that predate the ranking projection are unaffected.
    async list({ scope, limit }) {
      if (failScopes.includes(scope)) return { ok: false };
      const stamp = (e) => String(e?.updatedAt ?? e?.updated ?? '');
      const entries = [...(byScope[scope] || [])].sort((a, b) => stamp(b).localeCompare(stamp(a)));
      return { ok: true, entries: limit ? entries.slice(0, limit) : entries };
    },
  };
}

test('fetchLessons keeps the most-specific value per key — same as resolvePrecedence', async () => {
  // deriveScope on this repo yields project → branch? → repo → global; seed the
  // duplicate key at every possible scope so whichever leads wins deterministically.
  const shared = (scope, v) => ({ scope, key: 'shared', value: v });
  const byScope = {};
  // Build groups in readOrder to compute the expected winners independently.
  const scope = REAL_SCOPE;
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
  const scope = REAL_SCOPE;
  const first = scope.readOrder[0];
  const last = scope.readOrder[scope.readOrder.length - 1];
  const store = fakeStore({ [last]: [{ scope: last, key: 'survivor', value: 'v' }] }, { failScopes: [first] });
  const { lessons } = await fetchLessons(store, process.cwd());
  assert.deepEqual(lessons.map((l) => l.key), ['survivor']);
});

test('fetchLessons has no fixed count cap — only the hard safety ceiling', async (t) => {
  // The old `MAX_LESSONS = 15` was both a ceiling AND a floor: any group of
  // candidates became exactly 15, whatever they cost. The bound is now the character
  // budget at RENDER time, so the fetch returns everything up to a worst-case
  // safety ceiling and lets `formatLessons` decide what fits.
  //
  // Both fixtures are spread ACROSS scopes rather than piled into one, because
  // `fetchLessons` reads each scope with `limit: 25` and `fakeStore` honours it:
  // a 30-row single-scope group is a read the store can never return, so the
  // scenario would be unreachable and the assertion would pin the read cap
  // rather than the absence of a count cap.
  const scope = REAL_SCOPE;
  if (scope.readOrder.length < 2) {
    t.skip('needs at least two scopes to exceed the per-scope read limit');
    return;
  }
  const [a, b] = scope.readOrder;

  const spread = {
    [a]: Array.from({ length: 12 }, (_, i) => ({ scope: a, key: `a${i}`, value: 'v' })),
    [b]: Array.from({ length: 12 }, (_, i) => ({ scope: b, key: `b${i}`, value: 'v' })),
  };
  const { lessons, applicable } = await fetchLessons(fakeStore(spread), process.cwd());
  assert.equal(lessons.length, 24, 'not truncated to a magic number');
  assert.equal(applicable, 24);

  // Every scope read to its limit overruns the documented worst-case ceiling
  // (40), so a huge store can never materialise an unbounded index.
  const huge = Object.fromEntries(scope.readOrder.map((s) => [
    s,
    Array.from({ length: 25 }, (_, i) => ({ scope: s, key: `${s}-h${i}`, value: 'v' })),
  ]));
  const seeded = 25 * scope.readOrder.length;
  const big = await fetchLessons(fakeStore(huge), process.cwd());
  assert.equal(big.lessons.length, 40, 'hard ceiling still bounds the worst case');
  assert.equal(big.applicable, seeded, 'but the applicable total is counted before it');
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

// The count cap the injected set USED to have (`MAX_LESSONS = 15`), kept here as
// a local literal because it is a HISTORICAL value, not a live one: the
// regression guard below replays the pre-ranking path to prove what that path
// would have dropped. Binding it to a current constant would be wrong twice
// over — production has no count cap left to bind to, and a guard that moves
// with today's bound stops describing the behaviour it exists to pin.
const PRE_RANKING_CAP = 15;

// A lesson shaped the way the store layer now hands them over.
function seeded(scope, key, { days = 0, seen = 1, value = 'v' } = {}) {
  return { scope, key, value, seenCount: seen, updatedAt: rankDaysAgo(days) };
}

test('fetchLessons ranked — the injected set is ordered by score, not by group order', async () => {
  const scope = REAL_SCOPE;
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
  const scope = REAL_SCOPE;
  const s = scope.readOrder[0];

  // The reported shape: one task's iteration log, written today, plus the
  // hard-won lesson from last week. Under the old recency cap the flood took
  // every slot and `hard-won` was never injected.
  //
  // 20, not 30: `fetchLessons` reads each scope with `limit: 25`, so a larger
  // single-scope group is a read the store can never return and the scenario
  // would be unreachable. 20 + `hard-won` = 21 rows survive the read and still
  // over-fill the historical count cap, which is the condition under test.
  const flood = Array.from({ length: 20 }, (_, i) => seeded(s, `iteration-${i}`, { days: 0, seen: 1 }));
  const entries = [...flood, seeded(s, 'hard-won', { days: 7, seen: 12 })];

  const { lessons } = await fetchLessons(fakeStore({ [s]: entries }), process.cwd(), { now: RANK_NOW });

  assert.equal(lessons[0].key, 'hard-won', 'it is now the FIRST thing the agent reads');

  // The regression guard: prove the PRE-RANKING path would have dropped it.
  // Replay that path rather than slicing `entries` — in the fixture `hard-won`
  // is appended last, so a slice of `entries` holds whatever the merge does and
  // guards nothing. Here the group is ordered the way `store.list` contracts to
  // (newest-first), run through the SAME `resolvePrecedence` merge
  // `fetchLessons` runs, then capped: `hard-won` falls outside the cap because
  // it is OLDER than the flood, which is the property that actually regressed.
  const newestFirst = [...entries].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const { groups: preRanking } = resolvePrecedence({
    groups: [{ scope: s, error: null, entries: newestFirst }],
  });
  const preRankingKeys = preRanking
    .flatMap((g) => g.entries)
    .filter((e) => e.winning)
    .slice(0, PRE_RANKING_CAP)
    .map((e) => e.key);
  assert.equal(preRankingKeys.length, PRE_RANKING_CAP, 'precondition — the pre-ranking cap was actually saturated');
  assert.ok(
    !preRankingKeys.includes('hard-won'),
    'precondition — the pre-ranking cap did not include it',
  );
});

test('fetchLessons ranked — with nothing recurring, the order is still recency', async () => {
  // Salience must not invent a preference where there is no recurrence signal:
  // a store of pure one-offs should behave exactly as it always did.
  const scope = REAL_SCOPE;
  const s = scope.readOrder[0];
  const entries = [
    seeded(s, 'c', { days: 30 }),
    seeded(s, 'a', { days: 1 }),
    seeded(s, 'b', { days: 10 }),
  ];
  const { lessons } = await fetchLessons(fakeStore({ [s]: entries }), process.cwd(), { now: RANK_NOW });
  assert.deepEqual(lessons.map((l) => l.key), ['a', 'b', 'c']);
});

test('precedence unchanged — a shadowed lesson cannot be ranked back into the set', async (t) => {
  // The load-bearing property of running the scorer on the WINNERS only. The
  // global copy is made maximally attractive (very recent, highly recurring)
  // and the project copy maximally unattractive; precedence must still win,
  // because which copy of a key survives is a correctness rule and not a
  // preference the scorer gets a vote on.
  const scope = REAL_SCOPE;
  if (scope.readOrder.length < 2) {
    // Report the no-op instead of returning green. A bare `return` would let
    // this load-bearing precedence property go untested and unnoticed on any
    // checkout whose `deriveScope` yields a single scope.
    t.skip('needs at least two scopes to shadow');
    return;
  }
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

// ── the cross-scope budget trade, locked ─────────────────────────────────────
// `fetchLessons`'s docblock states that precedence settles same-key collisions
// only, and that across DIFFERENT keys the cap is one cross-scope ranking with
// `scopeOrder` as a tiebreak — so a recurring broad-scope lesson takes a slot
// from a fresher-but-one-off narrow-scope one. That was prose. These tests make it a
// contract: a future scope weight or per-scope floor has to fail here and be
// re-decided, rather than quietly changing what the agent reads.

test('ranking is cross-scope — a recurring broad lesson evicts a fresher narrow one-off', async (t) => {
  const scope = REAL_SCOPE;
  if (scope.readOrder.length < 2) {
    // Report the no-op rather than returning green — same reason as the
    // shadowing test above: silence here would hide the property, not prove it.
    t.skip('needs at least two scopes to compete for the cap');
    return;
  }
  const [narrow] = scope.readOrder;
  const broad = scope.readOrder[scope.readOrder.length - 1];

  // Enough narrow-scope one-offs to fill any plausible budget from the
  // most-specific scope alone — the shape the OLD group order produced, in
  // which no broad-scope lesson could ever be injected. Distinct keys, so
  // precedence shadows nothing and the ranking is the only thing under test.
  //
  // THE FIXTURE IS DELIBERATELY STACKED AGAINST THE CLAIM. The docblock's claim
  // is that a RECURRING broad lesson displaces a FRESHER-BUT-ONE-OFF narrow one,
  // so the narrow rows are written today and the broad ones a week ago: recency
  // argues for keeping the narrow rows, and only salience can explain the
  // eviction. Seeding the narrow rows stale instead would let plain recency
  // produce the same result and the test would pin nothing.
  // `scoreLesson` AVERAGES its three equally-weighted factors — relevance is in
  // the divisor even though `terms: []` makes it 0 here — so each line below is
  // (recency + salience + 0) / 3, the 3 being the sum of `DEFAULT_RANK_WEIGHTS`:
  //   narrow: (1.00 + log1p(1)/log1p(30)) / 3 = (1.00 + 0.20) / 3 ≈ 0.40
  //   broad:  (0.5^(7/14)      + 1.00   ) / 3 = (0.71 + 1.00) / 3 ≈ 0.57
  const narrowRows = Array.from({ length: 15 }, (_, i) =>
    seeded(narrow, `narrow-${String(i).padStart(2, '0')}`, { days: 0, seen: 1 }),
  );
  const broadRows = Array.from({ length: 3 }, (_, i) =>
    seeded(broad, `broad-recurring-${i}`, { days: 7, seen: 30 }),
  );

  const { lessons } = await fetchLessons(
    fakeStore({ [narrow]: narrowRows, [broad]: broadRows }),
    process.cwd(),
    { now: RANK_NOW },
  );

  assert.deepEqual(
    lessons.slice(0, 3).map((l) => l.scope),
    [broad, broad, broad],
    'the recurring broad lessons lead — score decides, scope does not reserve',
  );

  // THE EVICTION IS NOW THE BUDGET'S, NOT THE FETCH'S. `fetchLessons` no longer
  // caps at a count, so the trade this test names — a recurring broad lesson
  // displacing a fresher narrow one — is only observable once something is
  // actually left out. Render under a budget that fits exactly three lesson
  // lines and assert WHICH three survive.
  //
  // The budget is measured from the unbounded render rather than hand-counted,
  // so a change to the header or the line format cannot silently turn this into
  // a test of arithmetic. `index` mode is used so no scope-map line is reserved
  // out of the budget — the reservation is `hybrid`'s behaviour and has its own
  // coverage.
  // `fitLines` charges the budget for the lesson lines only (each `+ 1` for the
  // newline that joins it) — the header is not billed — so the budget is summed
  // the same way rather than from the whole rendered block.
  const [, ...allLines] = formatLessons(lessons, scope, { mode: 'index' }).split('\n');
  const roomForThree = allLines.slice(0, 3).reduce((n, l) => n + l.length + 1, 0);

  const tight = formatLessons(lessons, scope, { mode: 'index', maxChars: roomForThree });
  const shownLines = tight.split('\n').slice(1);
  assert.equal(shownLines.length, 3, 'precondition — the budget fits exactly three lesson lines');
  assert.ok(
    shownLines.every((l) => l.startsWith(`- (${broad}) `)),
    'the recurring broad lessons are what the budget keeps',
  );
  assert.ok(
    !tight.includes(`(${narrow})`),
    'every fresher narrow one-off was evicted, which is the accepted cost of the trade',
  );
});

test('ranking is cross-scope — but the narrower scope still wins an equal score', async (t) => {
  // The other half of the trade, and the reason `scopeOrder` is passed at all:
  // the hierarchy is a real tiebreak, so when the score says nothing it decides.
  // Both entries are identical in every scoring input and differ only in scope.
  const scope = REAL_SCOPE;
  if (scope.readOrder.length < 2) {
    t.skip('needs at least two scopes to compete for the cap');
    return;
  }
  const [narrow] = scope.readOrder;
  const broad = scope.readOrder[scope.readOrder.length - 1];

  const { lessons } = await fetchLessons(
    fakeStore({
      [narrow]: [seeded(narrow, 'a-narrow', { days: 3, seen: 4 })],
      [broad]: [seeded(broad, 'a-broad', { days: 3, seen: 4 })],
    }),
    process.cwd(),
    { now: RANK_NOW },
  );

  assert.deepEqual(lessons.map((l) => l.scope), [narrow, broad]);
});

test('fetchLessons ranked — an entry with no ranking fields is still injected', async () => {
  // A store that predates the seenCount/updatedAt projection (or a scope read
  // that returned bare rows) must not vanish from the injection just because it
  // scores zero — the hook is best-effort and a lesson is better than nothing.
  const scope = REAL_SCOPE;
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
  const scope = REAL_SCOPE;
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

// ── PR 4: the budget-aware SessionStart cap, the scope map, and the modes ─────
//
// The count cap is gone. What bounds the injected block now is a CHARACTER
// budget (`hooks.sessionStart.maxChars`), and what happens to the lessons that
// do not fit is decided by a shape (`hooks.sessionStart`): `hybrid` names them
// in a one-line scope map, `index` truncates silently, `map` leads with the
// inventory. These tests pin all three plus the two degenerate sizes — a store
// far under the budget and a store far over it.

const BUDGET_SCOPE = { repoScope: 'repo::acme/widget' };

// A lesson with a predictable line length, so a budget assertion is arithmetic
// rather than a guess.
function budgetLesson(i, { scope = 'repo::acme/widget', value = 'a lesson body that is long enough to cost something' } = {}) {
  return { scope, key: `lesson-${String(i).padStart(3, '0')}`, value };
}

test('sessionStart budget — the block stops at the configured character budget', () => {
  const lessons = Array.from({ length: 40 }, (_, i) => budgetLesson(i));
  const text = formatLessons(lessons, BUDGET_SCOPE, { maxChars: 600, applicable: 40 });

  assert.ok(text.length <= 600 + headerLength(text), 'lesson lines respect the budget');
  const lines = indexLines(text);
  assert.ok(lines.length > 0 && lines.length < 40, `truncated to ${lines.length} of 40`);

  // A LARGER budget must show strictly more — otherwise the number is decorative.
  const roomier = indexLines(formatLessons(lessons, BUDGET_SCOPE, { maxChars: 1500, applicable: 40 }));
  assert.ok(roomier.length > lines.length, 'a bigger budget shows more lessons');

  // And there is no residual magic 15 anywhere in the path.
  assert.notEqual(roomier.length, 15, 'not the old fixed count');
});

test('sessionStart budget — one over-long lesson still renders, never an empty index', () => {
  // A header with nothing under it tells the reader nothing and looks identical
  // to an empty store. One visible overrun beats a silent blank.
  const giant = [{ scope: 'global', key: 'k'.repeat(300), value: 'v'.repeat(300) }];
  const text = formatLessons(giant, BUDGET_SCOPE, { maxChars: 200, applicable: 1 });
  assert.equal(indexLines(text).length, 1);
});

test('sessionStart map fallback — a 500-lesson store renders a scope map, not an arbitrary slice', () => {
  const lessons = [
    ...Array.from({ length: 400 }, (_, i) => budgetLesson(i, { scope: 'repo::acme/widget' })),
    ...Array.from({ length: 100 }, (_, i) => budgetLesson(i + 400, { scope: 'global' })),
  ];
  const scopeCounts = [
    { scope: 'repo::acme/widget', count: 400, atReadLimit: true },
    { scope: 'global', count: 100, atReadLimit: false },
  ];
  const text = formatLessons(lessons, BUDGET_SCOPE, { maxChars: 1500, scopeCounts, applicable: 500 });

  const shown = indexLines(text).length;
  assert.ok(shown > 0 && shown < 500);
  assert.match(text, /^More lore: /m, 'the remainder is named, not silently dropped');
  assert.match(text, /repo::acme\/widget 400\+/, 'a read-limited count is marked as a lower bound');
  assert.match(text, /global 100/);
  assert.match(text, /memory\.search or memory\.read to drill in/, 'and it says how to reach them');
  // The header admits the truncation rather than reporting only what it rendered.
  assert.match(text, new RegExp(`^LoreKit: ${shown} of 500 memories loaded ·`));
});

test('sessionStart under budget — a 6-lesson store renders all 6 with no map', () => {
  const lessons = Array.from({ length: 6 }, (_, i) => budgetLesson(i));
  const scopeCounts = [{ scope: 'repo::acme/widget', count: 6, atReadLimit: false }];
  const text = formatLessons(lessons, BUDGET_SCOPE, { maxChars: 1500, scopeCounts, applicable: 6 });

  assert.equal(indexLines(text).length, 6, 'no padding, no truncation');
  assert.ok(!/More lore:/.test(text), 'nothing was left out, so nothing claims otherwise');
  assert.match(text, /^LoreKit: 6 memories loaded ·/, 'and the header does not say "6 of 6"');
});

test('sessionStart modes — index, map and hybrid each produce their documented shape', () => {
  const lessons = Array.from({ length: 40 }, (_, i) => budgetLesson(i));
  const scopeCounts = [{ scope: 'repo::acme/widget', count: 40, atReadLimit: false }];
  const opts = { maxChars: 800, scopeCounts, applicable: 40 };

  const index = formatLessons(lessons, BUDGET_SCOPE, { ...opts, mode: 'index' });
  assert.ok(indexLines(index).length > 1);
  assert.ok(!/More lore:/.test(index), 'index truncates without a map — that is its whole difference');

  const map = formatLessons(lessons, BUDGET_SCOPE, { ...opts, mode: 'map' });
  assert.equal(indexLines(map).length, 3, 'map leads with the inventory plus a few salient lessons');
  assert.match(map, /^More lore: /m);

  const hybrid = formatLessons(lessons, BUDGET_SCOPE, { ...opts, mode: 'hybrid' });
  assert.ok(indexLines(hybrid).length > indexLines(map).length, 'hybrid fills the budget first');
  assert.match(hybrid, /^More lore: /m, 'and names the remainder');

  // An unrecognised mode is hybrid, never a blank block.
  const junk = formatLessons(lessons, BUDGET_SCOPE, { ...opts, mode: 'nonsense' });
  assert.equal(junk, hybrid);
});

test('sessionStart default — an unconfigured caller gets hybrid at the default budget', () => {
  const lessons = Array.from({ length: 40 }, (_, i) => budgetLesson(i));
  const scopeCounts = [{ scope: 'repo::acme/widget', count: 40, atReadLimit: false }];

  // No mode, no maxChars — exactly what a repo with no `.lorekit.json` gets.
  const bare = formatLessons(lessons, BUDGET_SCOPE, { scopeCounts, applicable: 40 });
  const explicit = formatLessons(lessons, BUDGET_SCOPE, {
    scopeCounts, applicable: 40, mode: 'hybrid', maxChars: 1500,
  });
  assert.equal(bare, explicit, 'the defaults are the documented ones');

  // And it never throws on a missing/garbage budget — this runs inside a hook.
  for (const maxChars of [undefined, null, 0, -1, NaN, 'lots']) {
    const text = formatLessons(lessons, BUDGET_SCOPE, { scopeCounts, applicable: 40, maxChars });
    assert.ok(typeof text === 'string' && text.length > 0, `degrades for ${String(maxChars)}`);
  }
  // Absent scopeCounts simply means no map — never a crash.
  assert.ok(formatLessons(lessons, BUDGET_SCOPE, { applicable: 40 }).length > 0);
});

test('sessionStart budget — an empty store is unchanged (null, or the instruction alone)', () => {
  assert.equal(formatLessons([], BUDGET_SCOPE, { maxChars: 1500 }), null);
  const withInstruction = formatLessons([], BUDGET_SCOPE, { instruction: 'be careful' });
  assert.match(withInstruction, /^LoreKit: 0 memories loaded ·/);
  assert.match(withInstruction, /Project instruction: be careful/);
});

test('fetchLessons scope map — counts come from the winners, per scope, in readOrder', async () => {
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const [first, ...rest] = scope.readOrder;
  const last = rest[rest.length - 1] ?? first;
  const byScope = {
    [first]: [{ key: 'a', value: 'v' }, { key: 'shared', value: 'near' }],
    [last]: [{ key: 'shared', value: 'far' }, { key: 'b', value: 'v' }],
  };
  const { scopeCounts } = await fetchLessons(fakeStore(byScope), process.cwd());

  const counts = Object.fromEntries(scopeCounts.map((s) => [s.scope, s.count]));
  assert.equal(counts[first], 2);
  // `shared` is shadowed at the broader scope, so it is NOT counted twice — the
  // map describes what the reader can act on, not what is stored.
  assert.equal(counts[last], 1);
  assert.deepEqual(
    scopeCounts.map((s) => s.scope),
    scope.readOrder.filter((s) => counts[s] > 0),
    'ordered by the hierarchy, not by count',
  );
  assert.ok(scopeCounts.every((s) => s.atReadLimit === false), 'nothing hit the per-scope read cap');
});

// The `+` suffix is the only thing that stops a capped count from reading as an
// exact total, and until now nothing drove it through `fetchLessons` — the true
// case was hand-built straight into `renderScopeMap`, so the `raw.length >=
// SCOPE_READ_LIMIT` detection in the fetch itself was never exercised. The
// threshold is imported, not retyped: an assertion that restates a production
// constant goes vacuous the moment the constant moves.
test('fetchLessons scope map — a scope read to the cap reports a lower bound, not a total', async () => {
  const { deriveScope } = await import('../src/scope.mjs');
  const scope = deriveScope(process.cwd());
  const [capped, ...rest] = scope.readOrder;
  const under = rest[rest.length - 1] ?? null;

  const byScope = {
    // Exactly the cap: what a real store returns when there is more behind it.
    [capped]: Array.from({ length: SCOPE_READ_LIMIT }, (_, i) => ({ key: `k${i}`, value: `v${i}` })),
  };
  if (under) byScope[under] = [{ key: 'lonely', value: 'v' }];

  const { scopeCounts } = await fetchLessons(fakeStore(byScope), process.cwd());
  const rows = Object.fromEntries(scopeCounts.map((s) => [s.scope, s]));

  assert.equal(rows[capped].count, SCOPE_READ_LIMIT, 'precondition — the capped scope really is saturated');
  assert.equal(rows[capped].atReadLimit, true, 'a read that came back full is a floor, not a total');
  if (under) assert.equal(rows[under].atReadLimit, false, 'a scope under the cap is an exact count');

  const map = renderScopeMap(scopeCounts);
  assert.ok(
    map.includes(`${capped} ${SCOPE_READ_LIMIT}+`),
    'the capped scope renders with the + suffix',
  );
  if (under) assert.doesNotMatch(map, /lonely/, 'the map names scopes and counts, not keys');
});

// The header is not part of the lesson budget — it is the frame. Measure it so
// the budget assertion above is about the lines it actually bounds.
function headerLength(text) {
  return text.split('\n')[0].length + 1;
}
function indexLines(text) {
  return text.split('\n').filter((l) => l.startsWith('- ('));
}

// ── the per-prompt relevance pull ────────────────────────────────────────────
// SessionStart injects before the user has said what they are doing, so its set
// is necessarily a guess. This hook fires once there IS something to rank on.
// Because it fires on EVERY turn, every test below is really about when it
// stays QUIET — silence is the default answer, not the failure case.

test('promptQuery — the length gate skips the acknowledgements a session is full of', () => {
  for (const trivial of ['', '   ', 'yes', 'ok', 'continue', 'do it', 'next', 'go on']) {
    assert.deepEqual(promptQuery(trivial), [], `"${trivial}" must not become a query`);
  }
});

test('promptQuery — a substantive prompt distils to searchable terms', () => {
  const terms = promptQuery('the migration keeps deadlocking when the backfill runs concurrently');
  assert.ok(terms.includes('migration'));
  assert.ok(terms.includes('deadlocking'));
  assert.ok(terms.includes('backfill'));
  // Short words are dropped by MIN_TERM_LEN, so the query stays meaningful.
  assert.ok(!terms.includes('the'));
  // And the shared STOPWORDS list applies — the SAME list the failure lookup
  // uses, so "why did the failure hook find this and my prompt not?" has an
  // answer that is not "they tokenize differently".
  assert.ok(!promptQuery('this error failed with that response status code').includes('error'));
});

test('promptQuery — a long prompt carrying no usable term yields no terms', () => {
  // Passes the length gate, caught by the term gate. Two cheap checks in
  // series rather than one clever one: short words go by length, the rest by
  // the shared stopword list.
  assert.deepEqual(promptQuery('and the of it is to be for on with that this'), []);
  assert.deepEqual(promptQuery('the tool call failed with this error code status'), []);
});

test('promptQuery — terms are FTS-safe, so no caller has to escape one', () => {
  // They are joined into a single `websearch` query by the remote store. A
  // metacharacter surviving the tokenizer would corrupt that query.
  const terms = promptQuery('why does "SELECT * FROM x" fail with error(42) & timeout?');
  assert.ok(terms.length > 0);
  for (const t of terms) assert.match(t, /^[a-z0-9]+$/, `"${t}" is not FTS-safe`);
});

test('isSubstantivePrompt — the boundary is on the trimmed length', () => {
  assert.equal(isSubstantivePrompt('x'.repeat(23)), false);
  assert.equal(isSubstantivePrompt('x'.repeat(24)), true);
  assert.equal(isSubstantivePrompt(`   ${'x'.repeat(24)}   `), true, 'whitespace is not content');
  assert.equal(isSubstantivePrompt(null), false);
  assert.equal(isSubstantivePrompt(undefined), false);
});

// A store whose `search` returns a FIXED set, so these tests are about the
// hook's selection rules rather than about matching — which is the store's job
// and is already covered by the corpus-backed `searchStore` above.
function fixedHitsStore(entries) {
  return { async search() { return { ok: true, entries }; } };
}

const PROMPT_SCOPE = { readOrder: ['repo::acme/widget', 'global'] };
const PROMPT_NOW = Date.parse('2026-08-01T00:00:00.000Z');
const pDaysAgo = (n) => new Date(PROMPT_NOW - n * 86400000).toISOString();

test('promptLessonsFromStore — ranks the hits rather than trusting the store order', async () => {
  // The store's own ordering is not relevance: the remote route answers
  // `updated_at desc` and the local two-tier store answers project-tier-first.
  const entries = [
    { scope: 'global', key: 'fresh-oneoff', value: 'migration note', seenCount: 1, updatedAt: pDaysAgo(0) },
    { scope: 'global', key: 'recurring', value: 'migration note', seenCount: 20, updatedAt: pDaysAgo(4) },
  ];
  const out = await promptLessonsFromStore(fixedHitsStore(entries), PROMPT_SCOPE, ['migration'], { now: PROMPT_NOW });
  assert.deepEqual(out.map((e) => e.key), ['recurring', 'fresh-oneoff']);
});

test('promptLessonsFromStore — caps at three, because this interrupts the user', async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    scope: 'global', key: `k${i}`, value: 'migration', seenCount: 10 - i, updatedAt: pDaysAgo(1),
  }));
  const out = await promptLessonsFromStore(fixedHitsStore(entries), PROMPT_SCOPE, ['migration'], { now: PROMPT_NOW });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.key), ['k0', 'k1', 'k2'], 'and they are the top three by score');
});

test('promptLessonsFromStore — a lesson already shown this session is dropped', async () => {
  // The delta rule. Re-injecting the same lesson every turn of a conversation
  // that stays on one topic is exactly how an injection becomes wallpaper.
  const entries = [
    { scope: 'global', key: 'seen-already', value: 'migration', seenCount: 20, updatedAt: pDaysAgo(1) },
    { scope: 'global', key: 'genuinely-new', value: 'migration', seenCount: 1, updatedAt: pDaysAgo(9) },
  ];
  const out = await promptLessonsFromStore(fixedHitsStore(entries), PROMPT_SCOPE, ['migration'], {
    now: PROMPT_NOW,
    alreadyShown: new Set(['global::seen-already']),
  });
  assert.deepEqual(out.map((e) => e.key), ['genuinely-new'], 'the higher-scoring hit is skipped as old news');
});

test('promptLessonsFromStore — everything already shown means silence, not a filler pick', async () => {
  const entries = [{ scope: 'global', key: 'a', value: 'migration', seenCount: 3, updatedAt: pDaysAgo(1) }];
  const out = await promptLessonsFromStore(fixedHitsStore(entries), PROMPT_SCOPE, ['migration'], {
    now: PROMPT_NOW,
    alreadyShown: new Set(['global::a']),
  });
  assert.deepEqual(out, []);
});

test('promptLessonsFromStore — filters AFTER ranking, so the cap keeps its meaning', async () => {
  // Filtering first would let three weak lessons take the slots a strong but
  // already-shown one vacated. Showing two good ones beats padding to three.
  const entries = [
    { scope: 'global', key: 'shown-strong', value: 'migration', seenCount: 50, updatedAt: pDaysAgo(0) },
    { scope: 'global', key: 'b', value: 'migration', seenCount: 5, updatedAt: pDaysAgo(1) },
    { scope: 'global', key: 'c', value: 'migration', seenCount: 4, updatedAt: pDaysAgo(2) },
    { scope: 'global', key: 'd', value: 'migration', seenCount: 3, updatedAt: pDaysAgo(3) },
  ];
  const out = await promptLessonsFromStore(fixedHitsStore(entries), PROMPT_SCOPE, ['migration'], {
    now: PROMPT_NOW,
    alreadyShown: new Set(['global::shown-strong']),
  });
  assert.deepEqual(out.map((e) => e.key), ['b', 'c', 'd']);
});

test('promptLessonsFromStore — no terms, no store, or a throwing store all yield silence', async () => {
  assert.deepEqual(await promptLessonsFromStore(fixedHitsStore([]), PROMPT_SCOPE, []), []);
  assert.deepEqual(await promptLessonsFromStore(null, PROMPT_SCOPE, ['x']), []);
  assert.deepEqual(await promptLessonsFromStore({}, PROMPT_SCOPE, ['x']), []);
  const throwing = { async search() { throw new Error('offline'); } };
  assert.deepEqual(await promptLessonsFromStore(throwing, PROMPT_SCOPE, ['x']), []);
  const notOk = { async search() { return { ok: false }; } };
  assert.deepEqual(await promptLessonsFromStore(notOk, PROMPT_SCOPE, ['x']), []);
});

test('formatPromptLessons — an index block, never a body, and null when empty', () => {
  assert.equal(formatPromptLessons([]), null);
  assert.equal(formatPromptLessons(null), null);
  const text = formatPromptLessons([
    { scope: 'global', key: 'k', value: 'Always add the column before the backfill runs.\nMore detail here.' },
  ]);
  assert.match(text, /^LoreKit: 1 memory related to this — considerations, not rules/);
  assert.match(text, /^- \(global\) k — Always add the column before the backfill runs\.$/m);
  assert.ok(!text.includes('More detail here'), 'the body stays one memory.read away');
});

test('lessonId — one spelling of identity, shared by both sides of the shown-set', () => {
  assert.equal(lessonId({ scope: 'global', key: 'k' }), 'global::k');
  assert.equal(lessonId({}), '::');
  assert.equal(lessonId(null), '::');
});
