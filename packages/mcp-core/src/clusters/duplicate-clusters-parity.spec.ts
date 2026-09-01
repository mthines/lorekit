import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  tokenize as tokenizeTs,
  similarity as similarityTs,
  clusterDuplicates as clusterTs,
  clusterDuplicatesBlocked as clusterBlockedTs,
  RECURRENCE_CLUSTERS as CLUSTERS_TS,
  resolveRecurrenceClass as resolveTs,
  parseMetaComment as parseMetaTs,
  isCandidate as isCandidateTs,
  scoreCandidate as scoreTs,
} from './duplicate-clusters.js';

/**
 * CROSS-LANGUAGE PARITY: `packages/mcp-core/src/clusters/duplicate-clusters.ts`
 * (the server core, mirrored into the edge tree and read by
 * `GET /memories/clusters`) must cluster identically to
 * `packages/cli/src/shared/lessons-view.mjs` (what `lorekit dedupe` runs).
 *
 * Two implementations of one heuristic exist because the runtimes cannot share
 * a module: the CLI is a zero-dep `.mjs` package with no build step, and the
 * edge function cannot import from `packages/` at all. Every other duplicated
 * rule in this repo is guarded by a byte-for-byte comparison
 * (`edge-parity.spec.ts`), which is unavailable across languages — so the guard
 * is BEHAVIOURAL: run both over the same fixtures and require the same
 * clusters, in the same order, with the same similarity ranges.
 *
 * Without this, `lorekit dedupe` and the dashboard's Duplicate Clusters panel
 * would drift into disagreeing about which lessons are duplicates, silently.
 * The symptom ("the CLI found three, the dashboard found two") is the kind
 * nobody reports because nobody believes it.
 *
 * The same arrangement, for the same reason, as `lesson-rank-parity.spec.ts`.
 */

// The CLI is a plain `.mjs` package outside this project's tsconfig, so it is
// loaded by URL at runtime rather than as a typed import.
const cliDir = join(import.meta.dirname, '../../../cli/src/shared');
const cli = (await import(/* @vite-ignore */ `file://${join(cliDir, 'lessons-view.mjs')}`)) as {
  tokenize: (v: unknown) => Set<string>;
  similarity: (a: unknown, b: unknown) => number;
  clusterDuplicates: (entries: unknown[], threshold?: number) => CliCluster[];
  clusterDuplicatesBlocked: (entries: unknown[], threshold?: number) => CliCluster[];
};

interface CliCluster {
  members: { scope: string | null; key: string | null }[];
  size: number;
  minSimilarity: number;
  maxSimilarity: number;
}

const row = (scope: string, key: string, value: string, seenCount = 1) => ({
  scope,
  key,
  value,
  seenCount,
});

/**
 * A spread of shapes: exact duplicates, a transitive chain, unrelated rows,
 * punctuation/casing variants, and several scopes.
 *
 * **Every body is non-empty, deliberately.** The CLI's own
 * `clusterDuplicatesBlocked` drops the zero-token clique (two empty values
 * cluster in the reference sweep but share no inverted-index bucket), which the
 * TS copy fixes — see its docblock. That divergence is asserted explicitly at
 * the bottom of this file rather than hidden by omitting it, so this fixture set
 * pins the agreement over input both implementations handle the same way.
 */
const FIXTURES = [
  row('global', 'exact-a', 'alpha beta gamma delta epsilon zeta', 4),
  row('global', 'exact-b', 'alpha beta gamma delta epsilon zeta', 2),
  row('global', 'near-c', 'alpha beta gamma delta epsilon omega', 1),
  row('repo::acme/app', 'chain-d', 'one two three four five six', 3),
  row('repo::acme/app', 'chain-e', 'one two three four five seven', 1),
  row('repo::acme/app', 'chain-f', 'one two three four seven eight', 1),
  row('project::p', 'lonely-g', 'entirely different vocabulary altogether here', 9),
  row('branch::acme/app::main', 'punct-h', 'ALPHA! beta? GAMMA; delta: epsilon, zeta', 1),
  row('branch::acme/app::main', 'sub-i', 'alpha beta gamma', 1),
  row('global', 'long-j', 'the quick brown fox jumps over the lazy dog again and again', 1),
  row('global', 'long-k', 'the quick brown fox jumps over the lazy cat again and again', 1),
];

const THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];

/**
 * Both implementations, reduced to a comparable shape.
 *
 * The TS clusters carry the WHOLE member row (the handler needs `value` and
 * `seenCount` downstream) while the CLI's carry only `{scope, key}`, so the
 * comparison projects to `scope::key`. That is the only intentional difference
 * in the return shape, and projecting it away is what lets everything else —
 * membership, size, ordering, similarity range — be compared exactly.
 */
function shape(clusters: { members: { scope?: string | null; key?: string | null }[]; size: number; minSimilarity: number; maxSimilarity: number }[]) {
  return clusters.map((c) => ({
    members: c.members.map((m) => `${m.scope}::${m.key}`).sort(),
    size: c.size,
    min: Number(c.minSimilarity.toFixed(12)),
    max: Number(c.maxSimilarity.toFixed(12)),
  }));
}

describe('tokenize parity', () => {
  it.each([
    'alpha beta gamma',
    'ALPHA! beta? GAMMA;',
    '  leading and trailing  ',
    'digits123 and 456',
    'snake_case-and-kebab',
    '',
    '!!! ---',
    'unicode: café naïve',
  ])('agrees on %j', (input) => {
    expect([...tokenizeTs(input)]).toEqual([...cli.tokenize(input)]);
  });

  it('agrees on nullish input', () => {
    expect([...tokenizeTs(null)]).toEqual([...cli.tokenize(null)]);
    expect([...tokenizeTs(undefined)]).toEqual([...cli.tokenize(undefined)]);
  });
});

describe('similarity parity', () => {
  const PAIRS: [unknown, unknown][] = [
    ['alpha beta', 'beta alpha'],
    ['alpha beta', 'alpha gamma'],
    ['a b c', 'b c d'],
    ['alpha', 'beta'],
    ['', ''],
    ['', 'alpha'],
    ['alpha', ''],
    [null, undefined],
    [null, 'alpha'],
    ['the quick brown fox', 'the quick brown cat'],
  ];

  it.each(PAIRS)('agrees on (%j, %j)', (a, b) => {
    expect(similarityTs(a, b)).toBeCloseTo(cli.similarity(a, b), 12);
  });
});

describe('clusterDuplicates parity (the all-pairs reference)', () => {
  it.each(THRESHOLDS)('agrees at threshold %s', (threshold) => {
    expect(shape(clusterTs(FIXTURES, threshold))).toEqual(
      shape(cli.clusterDuplicates(FIXTURES, threshold)),
    );
  });

  it('agrees on the default threshold with no argument passed', () => {
    expect(shape(clusterTs(FIXTURES))).toEqual(shape(cli.clusterDuplicates(FIXTURES)));
  });

  it('agrees that the fixture set actually produces clusters (non-vacuous)', () => {
    // Without this, every assertion above would pass on two empty arrays.
    expect(clusterTs(FIXTURES, 0.8).length).toBeGreaterThan(0);
  });
});

describe('clusterDuplicatesBlocked parity (what both actually run)', () => {
  it.each(THRESHOLDS)('agrees at threshold %s', (threshold) => {
    expect(shape(clusterBlockedTs(FIXTURES, threshold))).toEqual(
      shape(cli.clusterDuplicatesBlocked(FIXTURES, threshold)),
    );
  });

  it('agrees on the default threshold with no argument passed', () => {
    expect(shape(clusterBlockedTs(FIXTURES))).toEqual(
      shape(cli.clusterDuplicatesBlocked(FIXTURES)),
    );
  });

  it('agrees that the fixture set actually produces clusters (non-vacuous)', () => {
    expect(clusterBlockedTs(FIXTURES, 0.8).length).toBeGreaterThan(0);
  });
});

describe('the ONE documented divergence: the zero-token clique', () => {
  const EMPTIES = [
    row('global', 'blank-a', ''),
    row('global', 'blank-b', '   '),
    row('global', 'real-c', 'actual content with real words here'),
  ];

  /**
   * Pinned as an EXPLICIT expectation, not omitted from the fixtures, because a
   * divergence a test file merely avoids is a divergence nobody knows about. If
   * the CLI is ever fixed this test fails and should be deleted along with the
   * TS docblock's note — which is the correct outcome, and the reason it asserts
   * the CLI's current behaviour rather than skipping.
   */
  it('the CLI drops it (a real bug in lessons-view.mjs) and the TS copy does not', () => {
    // The reference sweep finds it on BOTH sides — `similarity('', '') === 1`.
    expect(cli.clusterDuplicates(EMPTIES, 0.8)).toHaveLength(1);
    expect(clusterTs(EMPTIES, 0.8)).toHaveLength(1);

    // The blocked variant is where they part: no shared index bucket.
    expect(cli.clusterDuplicatesBlocked(EMPTIES, 0.8)).toHaveLength(0);

    const ours = clusterBlockedTs(EMPTIES, 0.8);
    expect(ours).toHaveLength(1);
    expect(ours[0].members.map((m) => m.key).sort()).toEqual(['blank-a', 'blank-b']);
    expect(ours[0].minSimilarity).toBe(1);
  });

  it('so the TS blocked variant matches its OWN reference where the CLI cannot', () => {
    expect(shape(clusterBlockedTs(EMPTIES, 0.8))).toEqual(shape(clusterTs(EMPTIES, 0.8)));
  });
});

/**
 * The recurrence registry and the candidate ranking are ports of
 * `recurrence-clusters.mjs` / `candidates-pure.mjs`, which land on `main` with
 * PR #608 and are ABSENT while it is unmerged.
 *
 * The skip is verified rather than assumed: when the CLI files are absent, an
 * assertion pins that absence, so this block cannot fail open. The moment #608
 * merges, the real comparisons run — and a divergence fails the build instead of
 * being silently tolerated by a test that shrugged.
 */
const cliRecurrencePath = join(cliDir, 'recurrence-clusters.mjs');
const cliCandidatesPath = join(cliDir, 'candidates-pure.mjs');
const cliRegistryPresent = existsSync(cliRecurrencePath) && existsSync(cliCandidatesPath);

describe('recurrence registry + candidate ranking parity', () => {
  it.skipIf(cliRegistryPresent)(
    'is not yet comparable — the CLI originals are absent until PR #608 merges',
    () => {
      // The negative assertion that stops this suite failing open: if either
      // file appears without the comparisons below being enabled, this fails.
      expect(existsSync(cliRecurrencePath)).toBe(false);
      expect(existsSync(cliCandidatesPath)).toBe(false);
    },
  );

  it.skipIf(!cliRegistryPresent)('agrees on every class id, name and lessonKey', async () => {
    const cliRec = (await import(/* @vite-ignore */ `file://${cliRecurrencePath}`)) as {
      RECURRENCE_CLUSTERS: { id: string; name: string; lessonKey: string }[];
    };
    const project = (list: readonly { id: string; name: string; lessonKey: string }[]) =>
      list.map((c) => ({ id: c.id, name: c.name, lessonKey: c.lessonKey }));
    expect(project(CLUSTERS_TS)).toEqual(project(cliRec.RECURRENCE_CLUSTERS));
  });

  it.skipIf(!cliRegistryPresent)('agrees on resolveRecurrenceClass over the registry', async () => {
    const cliRec = (await import(/* @vite-ignore */ `file://${cliRecurrencePath}`)) as {
      RECURRENCE_CLUSTERS: { id: string; lessonKey: string }[];
      resolveRecurrenceClass: (members: unknown[], clusters?: unknown[]) => unknown;
    };
    const cases = [
      [],
      [{ key: 'unknown::thing' }],
      [{ key: cliRec.RECURRENCE_CLUSTERS[0].lessonKey }],
      [{ key: cliRec.RECURRENCE_CLUSTERS[0].lessonKey }, { key: 'unknown::thing' }],
      cliRec.RECURRENCE_CLUSTERS.map((c) => ({ key: c.lessonKey })),
    ];
    for (const members of cases) {
      expect(resolveTs(members)).toEqual(cliRec.resolveRecurrenceClass(members));
    }
  });

  it.skipIf(!cliRegistryPresent)('agrees on parseMetaComment, isCandidate and scoreCandidate', async () => {
    const cliCand = (await import(/* @vite-ignore */ `file://${cliCandidatesPath}`)) as {
      parseMetaComment: (v: unknown) => Record<string, string>;
      isCandidate: (members: unknown[], opts?: unknown) => boolean;
      scoreCandidate: (members: unknown[]) => number;
    };
    const values = [
      '<!-- meta: seen_count=3 status=active -->body',
      '<!-- meta: trigger-context="length > 0" status=structural -->',
      '<!-- meta: t="say \\"hi\\"" -->',
      'no meta at all',
      '<!-- meta: unterminated',
      '',
    ];
    for (const v of values) {
      expect(parseMetaTs(v)).toEqual(cliCand.parseMetaComment(v));
    }

    const memberSets = [
      [row('global', 'a', values[0], 2), row('global', 'b', values[0], 1)],
      [row('global', 'a', values[1], 1)],
      [row('global', 'a', values[3], 1)],
      [row('global', 'a', values[3], 3), row('repo::x/y', 'b', values[3], 3)],
    ];
    for (const members of memberSets) {
      expect(isCandidateTs(members)).toBe(cliCand.isCandidate(members));
      expect(scoreTs(members)).toBe(cliCand.scoreCandidate(members));
    }
  });
});
