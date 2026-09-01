// `lorekit obligations` — the Surface-Partner Map matcher + command.
//
// Three layers of coverage:
//   • pure glob/`{name}` mechanics (`globToRegExp`, `substituteName`, `stemOf`)
//   • the matcher (`checkObligations`) against small, hand-built maps —
//     met/unmet, `run:` advisory semantics, OR-group obliges, dedupe by id
//   • map integrity (every seed entry is well-formed) and the command's exit
//     contract, via captured writers (`setWriters`) — no network, no store.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_PREFIX,
  REGEX_PREFIX,
  stemOf,
  globToRegExp,
  substituteName,
  checkObligations,
} from '../src/shared/obligations-pure.mjs';
import { SURFACE_PARTNER_MAP } from '../src/shared/obligations-map.mjs';
import {
  RECURRENCE_CLUSTERS,
  clusterForEntry,
  lessonKeyForEntry,
  clusterMembers,
} from '../src/shared/recurrence-clusters.mjs';
import { obligations } from '../src/commands/obligations.mjs';
import { setWriters } from '../src/shared/util.mjs';

// ── pure: globToRegExp — `**` / `*` / `re:` semantics ─────────────────────────

describe('globToRegExp', () => {
  test('`*` matches within one path segment only', () => {
    const re = globToRegExp('packages/cli/src/*.mjs');
    assert.equal(re.test('packages/cli/src/util.mjs'), true);
    assert.equal(re.test('packages/cli/src/shared/util.mjs'), false, '`*` must not cross a `/`');
  });

  test('`**` matches across path segments (including zero)', () => {
    const re = globToRegExp('packages/cli/skill/**');
    assert.equal(re.test('packages/cli/skill/lorekit-memory/SKILL.md'), true);
    assert.equal(re.test('packages/cli/skill/'), true, '`**` may match zero characters');
    assert.equal(re.test('packages/other/skill/x'), false, 'still anchored — a mismatched prefix never matches');
  });

  test('a `re:`-prefixed pattern is used verbatim as a RegExp', () => {
    const re = globToRegExp('re:^supabase/migrations/.*index.*\\.sql$');
    assert.equal(re.test('supabase/migrations/00060_index.sql'), true);
    assert.equal(re.test('supabase/migrations/00060_other.sql'), false);
  });

  test('an unparseable `re:` pattern returns null rather than throwing', () => {
    assert.equal(globToRegExp('re:(unclosed'), null);
  });

  test('literal characters are escaped, not interpreted as regex metacharacters', () => {
    const re = globToRegExp('docs/mcp-tools.md');
    assert.equal(re.test('docs/mcp-tools.md'), true);
    assert.equal(re.test('docsXmcp-toolsXmd'), false, '`.` must be literal, not "any char"');
  });
});

// ── pure: stemOf ────────────────────────────────────────────────────────────

describe('stemOf', () => {
  test('basename without extension', () => {
    assert.equal(stemOf('packages/mcp-core/src/audit/audit.ts'), 'audit');
    assert.equal(stemOf('a/b/c.generated.mjs'), 'c.generated');
  });

  test('a file with no extension is its own stem', () => {
    assert.equal(stemOf('a/b/README'), 'README');
  });

  test('a dotfile is its own stem, not an empty string', () => {
    assert.equal(stemOf('.env'), '.env');
  });
});

// ── pure: `{name}` interpolation — the edge↔core partner derivation ──────────

describe('`{name}` interpolation', () => {
  test('`**/{name}` captures the full relative subpath (dirs + stem), not just the basename', () => {
    const result = checkObligations({
      changedFiles: ['supabase/functions/_shared/audit/audit.ts'],
      map: [
        {
          id: 'x',
          match: 'supabase/functions/_shared/**/{name}.ts',
          obliges: ['packages/mcp-core/src/**/{name}.ts'],
          lessonKey: 'k',
        },
      ],
    });
    assert.equal(result.matched.length, 1);
    // The captured `{name}` ("audit/audit") round-trips through the OTHER
    // pattern's own `**/{name}` slot, reconstructing the exact concrete
    // partner path — not a `**`-glob a human would have to resolve by hand.
    assert.deepEqual(result.matched[0].obliges, [
      { target: 'packages/mcp-core/src/audit/audit.ts', kind: 'path', met: false },
    ]);
  });

  test('substituteName replaces the `**/{name}` unit as one token, and a bare `{name}` on its own', () => {
    assert.equal(
      substituteName('packages/mcp-core/src/**/{name}.ts', 'audit/audit'),
      'packages/mcp-core/src/audit/audit.ts',
    );
    assert.equal(substituteName('src/{name}.ts', 'scope'), 'src/scope.ts');
    assert.equal(substituteName('src/no-token.ts', 'scope'), 'src/no-token.ts', 'no token → unchanged');
  });

  test('substituteName is a no-op when no name was captured (name is null)', () => {
    assert.equal(substituteName('packages/mcp-core/src/**/{name}.ts', null), 'packages/mcp-core/src/**/{name}.ts');
  });
});

// ── pure: checkObligations — met / unmet / OR-groups / run: advisory ─────────

describe('checkObligations', () => {
  const twoWayMap = [
    { id: 'a', match: 'src/a/{name}.ts', obliges: ['dist/a/{name}.ts'], lessonKey: 'lk' },
  ];

  test('both partners present → met (unmet 0, ok true)', () => {
    const result = checkObligations({
      changedFiles: ['src/a/widget.ts', 'dist/a/widget.ts'],
      map: twoWayMap,
    });
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].obliges[0].met, true);
    assert.equal(result.unmet, 0);
    assert.equal(result.ok, true);
  });

  test('only the source present → unmet (unmet 1, ok false)', () => {
    const result = checkObligations({
      changedFiles: ['src/a/widget.ts'],
      map: twoWayMap,
    });
    assert.equal(result.matched[0].obliges[0].met, false);
    assert.equal(result.unmet, 1);
    assert.equal(result.ok, false);
  });

  test('a `run:`-prefixed oblige is advisory: met is always null and never counts toward unmet', () => {
    const result = checkObligations({
      changedFiles: ['packages/schemas/src/shared/tool-catalog.ts'],
      map: [
        {
          id: 'gen',
          match: 'packages/schemas/src/shared/tool-catalog.ts',
          obliges: ['run:pnpm nx generate:llms schemas', 'packages/web/public/llms.txt'],
          lessonKey: 'lk',
        },
      ],
    });
    const runRow = result.matched[0].obliges.find((o) => o.kind === 'action');
    assert.equal(runRow.met, null);
    assert.equal(runRow.target, 'run:pnpm nx generate:llms schemas');
    // Only the real (unmet) path oblige counts.
    assert.equal(result.unmet, 1);
  });

  test('an OR-group oblige (array of candidates) is met if ANY candidate is present', () => {
    const orMap = [
      {
        id: 'either',
        match: 'src/{name}.ts',
        obliges: [['candidate-a/{name}.ts', 'candidate-b/{name}.ts']],
        lessonKey: 'lk',
      },
    ];
    const metByA = checkObligations({ changedFiles: ['src/widget.ts', 'candidate-a/widget.ts'], map: orMap });
    assert.equal(metByA.matched[0].obliges[0].met, true);
    assert.equal(metByA.unmet, 0);

    const metByNeither = checkObligations({ changedFiles: ['src/widget.ts'], map: orMap });
    assert.equal(metByNeither.matched[0].obliges[0].met, false);
    assert.equal(metByNeither.unmet, 1);
  });

  test('the real edge-mirror / edge-mirror-core pair (audit.ts): both directions fire from the enumerated pairs inventory', () => {
    // This is the exact AC-3 scenario at the pure-function layer: both the
    // shared-file and its mcp-core partner in the changed-set must leave
    // `unmet` at 0. audit.ts is one of the pairs excluded from
    // edge-parity.spec.ts's byte-comparison drift check (driftChecked: false
    // in mirror-pairs.mjs) but is still a real obligations partner.
    const files = [
      'supabase/functions/_shared/audit/audit.ts',
      'packages/mcp-core/src/audit/audit.ts',
    ];
    const result = checkObligations({ changedFiles: files, map: SURFACE_PARTNER_MAP });
    const byId = Object.fromEntries(result.matched.map((e) => [e.id, e]));
    assert.ok(byId['edge-mirror'], 'edge-mirror should match');
    assert.ok(byId['edge-mirror-core'], 'edge-mirror-core should match');
    assert.equal(byId['edge-mirror'].obliges.every((o) => o.met !== false), true);
    assert.equal(byId['edge-mirror-core'].obliges.every((o) => o.met !== false), true);
    assert.equal(result.unmet, 0);
    assert.equal(result.ok, true);
  });

  test('a flattened/renamed edge mirror (auth-token.ts) resolves via the enumerated pairs inventory, not a symmetric-path guess', () => {
    // Regression for the false positive this fix replaces: the edge copy does
    // NOT preserve mcp-core's `auth/` subdirectory —
    // `packages/mcp-core/src/auth/auth-token.ts` mirrors the FLAT
    // `supabase/functions/mcp/auth-token.ts`. A `{name}` glob substitution
    // assuming a symmetric path would reconstruct the wrong partner
    // (`supabase/functions/mcp/auth/auth-token.ts`, which does not exist) and
    // report a genuinely-present mirror as chronically unmet.
    const core = 'packages/mcp-core/src/auth/auth-token.ts';
    const edge = 'supabase/functions/mcp/auth-token.ts';

    const both = checkObligations({ changedFiles: [core, edge], map: SURFACE_PARTNER_MAP });
    const byIdBoth = Object.fromEntries(both.matched.map((e) => [e.id, e]));
    const coreRow = byIdBoth['edge-mirror-core'].obliges.find((o) => o.target === edge);
    assert.ok(coreRow, 'edge-mirror-core should obligate the exact flattened edge path, not a reconstructed one');
    assert.equal(coreRow.met, true);
    assert.equal(both.unmet, 0);

    const onlyCore = checkObligations({ changedFiles: [core], map: SURFACE_PARTNER_MAP });
    const onlyCoreEntry = onlyCore.matched.find((e) => e.id === 'edge-mirror-core');
    assert.equal(onlyCoreEntry.obliges[0].target, edge);
    assert.equal(onlyCoreEntry.obliges[0].met, false);
    assert.equal(onlyCore.unmet, 1);
  });

  test('deduped by entry id: a file set hitting the same entry via two files still yields one matched entry', () => {
    const map = [
      { id: 'e', match: `${REGEX_PREFIX}^a/[^/]+\\.txt$`, obliges: ['b.txt'], lessonKey: 'lk' },
    ];
    const result = checkObligations({ changedFiles: ['a/one.txt', 'a/two.txt'], map });
    assert.equal(result.matched.length, 1);
    assert.equal(result.matched[0].obliges.length, 1, 'same substituted target from both files dedupes to one row');
  });

  test('is pure and total: malformed input degrades to no matches rather than throwing', () => {
    const empty = { files: [], matched: [], unmet: 0, unmetGating: 0, ok: true, okGating: true };
    assert.deepEqual(checkObligations({}), empty);
    assert.deepEqual(checkObligations({ changedFiles: null, map: null }), empty);
    assert.doesNotThrow(() => checkObligations({ changedFiles: ['x'], map: [{ id: 'bad', match: 42, obliges: 'oops' }] }));
  });
});

// ── map integrity: every seed entry is well-formed ────────────────────────────

// `edge-mirror`/`edge-mirror-core` intentionally repeat: one row per known
// mirror pair (`mirror-pairs.mjs`) shares the same logical id so
// `checkObligations` merges them into a single reported entry (see
// `obligations-pure.mjs`'s `byId` merge). Every OTHER id must stay unique.
const GROUPED_IDS = new Set(['edge-mirror', 'edge-mirror-core']);

describe('SURFACE_PARTNER_MAP integrity', () => {
  test('every entry has a stable id, a match, obliges, and a resolvable lesson key', () => {
    assert.ok(SURFACE_PARTNER_MAP.length >= 7, `expected at least 7 seed entries, got ${SURFACE_PARTNER_MAP.length}`);
    const singularIds = new Set();
    for (const entry of SURFACE_PARTNER_MAP) {
      assert.equal(typeof entry.id, 'string', `entry missing a string id: ${JSON.stringify(entry)}`);
      if (!GROUPED_IDS.has(entry.id)) {
        assert.ok(!singularIds.has(entry.id), `duplicate entry id: ${entry.id}`);
        singularIds.add(entry.id);
      }
      assert.ok(
        typeof entry.match === 'string' || Array.isArray(entry.match),
        `${entry.id}: match must be a string or string[]`,
      );
      assert.ok(Array.isArray(entry.obliges) && entry.obliges.length > 0, `${entry.id}: obliges must be a non-empty array`);
      const lessonKey = lessonKeyForEntry(entry);
      assert.equal(typeof lessonKey, 'string', `${entry.id}: must resolve to a lesson key`);
      assert.ok(lessonKey.length > 0, `${entry.id}: resolved lesson key must be non-empty`);
    }
  });

  test('every generated edge-mirror row derives from mirror-pairs.mjs — one obligated core/edge pair each', () => {
    const edgeMirrorRows = SURFACE_PARTNER_MAP.filter((e) => e.id === 'edge-mirror');
    const edgeMirrorCoreRows = SURFACE_PARTNER_MAP.filter((e) => e.id === 'edge-mirror-core');
    assert.ok(edgeMirrorRows.length >= 20, `expected the full mirror-pairs inventory, got ${edgeMirrorRows.length} edge-mirror rows`);
    assert.equal(edgeMirrorRows.length, edgeMirrorCoreRows.length, 'both directions are generated 1:1 from the same pairs');
    for (const row of [...edgeMirrorRows, ...edgeMirrorCoreRows]) {
      assert.equal(typeof row.match, 'string', 'each generated row matches one exact path, not a glob array');
      assert.equal(row.obliges.length, 1, 'each generated row obligates exactly its one known partner');
      assert.equal(typeof row.obliges[0], 'string', 'the obliged partner is a single exact path, not an OR-group');
    }
  });

  test('every match pattern (or `re:` source) compiles', () => {
    for (const entry of SURFACE_PARTNER_MAP) {
      const patterns = Array.isArray(entry.match) ? entry.match : [entry.match];
      for (const p of patterns) {
        assert.notEqual(globToRegExp(p), null, `${entry.id}: pattern "${p}" failed to compile`);
      }
    }
  });

  test('a run: oblige element always starts with the RUN_PREFIX constant', () => {
    for (const entry of SURFACE_PARTNER_MAP) {
      for (const o of entry.obliges) {
        if (typeof o === 'string' && o.startsWith('run:')) assert.ok(o.startsWith(RUN_PREFIX));
      }
    }
  });
});

// ── command: exit codes via captured writers ──────────────────────────────────

function capture(run) {
  let out = '';
  let err = '';
  const restore = setWriters({ out: (s) => { out += s; }, err: (s) => { err += s; } });
  return Promise.resolve(run()).then(
    (result) => { restore(); return { result, out, err }; },
    (e) => { restore(); throw e; },
  );
}

describe('obligations command', () => {
  test('exits 0 by default even with an unmet obligation (strict opts in)', async () => {
    const { result, out } = await capture(() =>
      obligations({ _: ['obligations', 'supabase/functions/_shared/audit/audit.ts'] }),
    );
    assert.equal(result.exitCode, 0);
    assert.match(out, /packages\/mcp-core\/src\/audit\/audit\.ts/);
    assert.equal(result['lorekit.cli.obligations.unmet'], 1);
    assert.equal(result['lorekit.cli.obligations.strict'], false);
  });

  test('--strict exits 1 when an obligation is unmet', async () => {
    const { result } = await capture(() =>
      obligations({ _: ['obligations', 'supabase/functions/_shared/audit/audit.ts'], strict: true }),
    );
    assert.equal(result.exitCode, 1);
  });

  test('--strict exits 0 when the changed-set covers both partners', async () => {
    const { result } = await capture(() =>
      obligations({
        _: ['obligations', 'supabase/functions/_shared/audit/audit.ts', 'packages/mcp-core/src/audit/audit.ts'],
        strict: true,
      }),
    );
    assert.equal(result.exitCode, 0);
  });

  test('--json prints a parseable, well-shaped result', async () => {
    const { result, out } = await capture(() =>
      obligations({ _: ['obligations', 'packages/schemas/src/shared/tool-catalog.ts'], json: true }),
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.files, ['packages/schemas/src/shared/tool-catalog.ts']);
    assert.ok(parsed.matched.some((e) => e.id === 'tool-catalog'));
    assert.equal(parsed.strict, false);
  });

  test('an empty changed-set reports no matches without error', async () => {
    // No positionals/--files falls back to reading stdin; force isTTY so the
    // command sees "nothing piped" and resolves immediately instead of
    // blocking on this in-process test's own (never-closing) stdin.
    const wasTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      const { result, out } = await capture(() => obligations({ _: ['obligations'] }));
      assert.equal(result.exitCode, 0);
      assert.match(out, /no known surface-partner obligations/);
    } finally {
      process.stdin.isTTY = wasTTY;
    }
  });

  test('positionals and --files both contribute to the changed-set, de-duplicated', async () => {
    const { result } = await capture(() =>
      obligations({
        _: ['obligations', 'supabase/functions/_shared/audit/audit.ts'],
        files: 'packages/mcp-core/src/audit/audit.ts',
        strict: true,
      }),
    );
    assert.equal(result.exitCode, 0, 'both partners supplied across positional + --files should satisfy the obligation');
    assert.equal(result['lorekit.cli.obligations.files'], 2);
  });
});

// ── recurrence clusters + the state ladder ───────────────────────────────────
//
// A map entry names the recurrence CLASS it instantiates rather than a bare
// lesson key, and carries a lifecycle (`state`, `owner`, `added`, `reviewBy`).
// The load-bearing rule is the guard/state coupling: an entry may only gate if
// something independent of the map already asserts the partnership.

describe('recurrence clusters', () => {
  test('every seed entry resolves to a known cluster and cites its lesson key', () => {
    for (const entry of SURFACE_PARTNER_MAP) {
      const cluster = clusterForEntry(entry);
      assert.ok(cluster, `entry ${entry.id} belongs to no known recurrence cluster`);
      assert.equal(typeof cluster.why, 'string');
      assert.ok(cluster.why.length > 0, `cluster ${cluster.id} must say why it recurs`);
      assert.equal(lessonKeyForEntry(entry), cluster.lessonKey);
    }
  });

  test('an explicit lessonKey on an entry overrides its cluster canonical key', () => {
    const entry = { id: 'x', cluster: 'sibling-set', lessonKey: 'other::key' };
    assert.equal(clusterForEntry(entry).id, 'sibling-set');
    assert.equal(lessonKeyForEntry(entry), 'other::key');
  });

  test('a bare lessonKey still resolves to its cluster, for un-migrated entries', () => {
    const cluster = RECURRENCE_CLUSTERS[0];
    assert.equal(clusterForEntry({ id: 'x', lessonKey: cluster.lessonKey }).id, cluster.id);
  });

  test('an unknown cluster or lesson key resolves to null rather than throwing', () => {
    assert.equal(clusterForEntry({ id: 'x', cluster: 'nope' }), null);
    assert.equal(clusterForEntry({ id: 'x', lessonKey: 'nope::nope' }), null);
    assert.equal(clusterForEntry(null), null);
    assert.equal(lessonKeyForEntry({ id: 'x' }), null);
  });

  test('clusterMembers lists each member id once, in map order', () => {
    const members = clusterMembers('sibling-set', SURFACE_PARTNER_MAP);
    assert.deepEqual(members, ['docs-section', 'plugin-skill', 'perf-index']);
    const copies = clusterMembers('copies-a-claim', SURFACE_PARTNER_MAP);
    assert.deepEqual(copies, [
      'edge-mirror',
      'edge-mirror-core',
      'tool-catalog',
      'llms-generated',
      'cli-flag-doc',
      'digest-contract-doc',
      'error-code-doc',
    ]);
  });
});

describe('the state ladder', () => {
  test('every seed entry declares a full lifecycle', () => {
    for (const entry of SURFACE_PARTNER_MAP) {
      assert.ok(
        ['advisory', 'gating', 'retired'].includes(entry.state),
        `entry ${entry.id} has an invalid state: ${entry.state}`,
      );
      assert.match(entry.owner ?? '', /^@/, `entry ${entry.id} needs an owner`);
      assert.match(entry.added ?? '', /^\d{4}-\d{2}-\d{2}$/);
      assert.match(entry.reviewBy ?? '', /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(entry.reviewBy > entry.added, `entry ${entry.id} reviewBy must follow added`);
    }
  });

  test('an entry with no independent guard may never be gating', () => {
    // The compilability rule, asserted in code: a gating check needs an
    // expected value that comes from somewhere other than this map. Without a
    // `guard`, the entry asserts only its author's belief and must stay
    // advisory — `perf-index` and `error-code-doc` are the two such entries.
    for (const entry of SURFACE_PARTNER_MAP) {
      if (entry.guard) continue;
      assert.equal(
        entry.state,
        'advisory',
        `entry ${entry.id} has no guard, so it must not be gating`,
      );
    }
  });

  test('checkObligations reports each matched entry state and cluster', () => {
    const { matched } = checkObligations({
      changedFiles: ['a/x.ts'],
      map: [
        { id: 'e', state: 'gating', cluster: 'sibling-set', match: 'a/*.ts', obliges: ['b/y.ts'] },
      ],
    });
    assert.equal(matched[0].state, 'gating');
    assert.equal(matched[0].cluster.id, 'sibling-set');
    assert.equal(matched[0].lessonKey, RECURRENCE_CLUSTERS.find((c) => c.id === 'sibling-set').lessonKey);
  });

  test('an entry with no declared state defaults to advisory, not gating', () => {
    const { matched, unmet, unmetGating } = checkObligations({
      changedFiles: ['a/x.ts'],
      map: [{ id: 'e', cluster: 'sibling-set', match: 'a/*.ts', obliges: ['b/y.ts'] }],
    });
    assert.equal(matched[0].state, 'advisory');
    assert.equal(unmet, 1);
    assert.equal(unmetGating, 0, 'an undeclared state must never gate');
  });

  test('unmetGating counts only gating entries; unmet counts every one', () => {
    const map = [
      { id: 'g', state: 'gating', cluster: 'sibling-set', match: 'a/*.ts', obliges: ['b/y.ts'] },
      { id: 'a', state: 'advisory', cluster: 'sibling-set', match: 'a/*.ts', obliges: ['c/z.ts'] },
    ];
    const r = checkObligations({ changedFiles: ['a/x.ts'], map });
    assert.equal(r.unmet, 2);
    assert.equal(r.unmetGating, 1);
    assert.equal(r.ok, false);
    assert.equal(r.okGating, false);
  });

  test('a retired entry is not reported and cannot gate', () => {
    const r = checkObligations({
      changedFiles: ['a/x.ts'],
      map: [{ id: 'e', state: 'retired', cluster: 'sibling-set', match: 'a/*.ts', obliges: ['b/y.ts'] }],
    });
    assert.deepEqual(r.matched, []);
    assert.equal(r.unmet, 0);
    assert.equal(r.unmetGating, 0);
  });
});

describe('obligations command — strict respects state', () => {
  test('--strict does not gate on an advisory-only miss', async () => {
    // `error-code-doc` (no guard, advisory) is the only entry matching this
    // file, and its own note says it may over-flag. It must not fail a build.
    const { result } = await capture(() =>
      obligations({ _: ['obligations', 'supabase/functions/mcp/mcp-handler.ts'], strict: true }),
    );
    assert.ok(result['lorekit.cli.obligations.unmet'] > 0, 'the advisory entry should still report');
    assert.equal(result['lorekit.cli.obligations.unmetGating'], 0);
    assert.equal(result.exitCode, 0);
  });

  test('--strict-all restores gating on every unmet obligation', async () => {
    const { result } = await capture(() =>
      obligations({ _: ['obligations', 'supabase/functions/mcp/mcp-handler.ts'], 'strict-all': true }),
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result['lorekit.cli.obligations.strictAll'], true);
  });

  test('--strict still gates on a gating miss', async () => {
    const { result } = await capture(() =>
      obligations({ _: ['obligations', 'supabase/functions/mcp/auth-token.ts'], strict: true }),
    );
    assert.equal(result.exitCode, 1);
    assert.ok(result['lorekit.cli.obligations.unmetGating'] > 0);
  });

  test('the rendered output labels state and names the recurrence class', async () => {
    const { out } = await capture(() =>
      obligations({ _: ['obligations', 'supabase/functions/mcp/mcp-handler.ts'] }),
    );
    assert.match(out, /error-code-doc \[advisory\]/);
    assert.match(out, /no guard — advisory only/);
    assert.match(out, /class: A partner copies a claim/);
    assert.match(out, /advisory \(reported, never gates\)/);
  });
});
