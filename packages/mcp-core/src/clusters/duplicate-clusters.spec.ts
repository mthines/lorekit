import { describe, it, expect } from 'vitest';
import {
  tokenize,
  similarity,
  clusterDuplicates,
  clusterDuplicatesBlocked,
  RECURRENCE_CLUSTERS,
  resolveRecurrenceClass,
  parseMetaComment,
  isCandidate,
  scoreCandidate,
  rankCandidates,
  DEFAULT_MIN_SEEN_COUNT,
} from './duplicate-clusters.js';

const row = (
  scope: string,
  key: string,
  value: string,
  seenCount: number | null = 1,
) => ({ scope, key, value, seenCount });

describe('tokenize', () => {
  it('lowercases and splits on every non-alphanumeric run', () => {
    expect([...tokenize('Foo-bar_BAZ, qux!')]).toEqual(['foo', 'bar', 'baz', 'qux']);
  });

  it('is total — never throws on a non-string', () => {
    for (const input of [null, undefined, 42, {}, [], true]) {
      expect(() => tokenize(input as unknown)).not.toThrow();
    }
  });

  /**
   * Nullish and an empty array collapse to the empty set; a number or object
   * STRINGIFIES first and so yields real tokens. Asserted rather than glossed
   * because it is the reason a row with a null `value` and a row with the number
   * 42 behave differently, and because `similarity`'s empty-vs-empty edge below
   * depends on knowing exactly which inputs land there.
   */
  it('collapses only nullish and empty input to the empty set', () => {
    expect(tokenize(null).size).toBe(0);
    expect(tokenize(undefined).size).toBe(0);
    expect(tokenize('').size).toBe(0);
    expect(tokenize('   !!! ---').size).toBe(0);
    expect([...tokenize(42 as unknown)]).toEqual(['42']);
    // "[object Object]" -> two "object" tokens, deduped by the Set to one.
    expect([...tokenize({} as unknown)]).toEqual(['object']);
  });

  it('deduplicates repeated tokens', () => {
    expect(tokenize('a a a b').size).toBe(2);
  });
});

describe('similarity', () => {
  it('is 1 for identical token sets', () => {
    expect(similarity('alpha beta', 'beta alpha')).toBe(1);
  });

  it('is 0 for disjoint token sets', () => {
    expect(similarity('alpha', 'beta')).toBe(0);
  });

  it('computes |A n B| / |A u B|', () => {
    // {a,b,c} vs {b,c,d} -> intersection 2, union 4
    expect(similarity('a b c', 'b c d')).toBeCloseTo(0.5, 10);
  });

  // Both edges are load-bearing, not incidental — see the docblock.
  it('treats two EMPTY bodies as identical', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity(null, undefined)).toBe(1);
  });

  it('treats empty against non-empty as DISJOINT, never as similar', () => {
    expect(similarity('', 'alpha beta')).toBe(0);
    expect(similarity('alpha beta', '')).toBe(0);
  });

  it('accepts pre-computed token Sets', () => {
    expect(similarity(tokenize('a b'), tokenize('a b'))).toBe(1);
  });
});

describe('clusterDuplicates', () => {
  it('returns nothing for fewer than two entries', () => {
    expect(clusterDuplicates([])).toEqual([]);
    expect(clusterDuplicates([row('global', 'a', 'alpha beta gamma')])).toEqual([]);
  });

  it('omits singletons — only groups of 2+ are clusters', () => {
    const clusters = clusterDuplicates([
      row('global', 'a', 'alpha beta gamma delta'),
      row('global', 'b', 'alpha beta gamma delta'),
      row('global', 'c', 'totally unrelated words here'),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.key).sort()).toEqual(['a', 'b']);
  });

  it('links transitively — a~b and b~c puts all three in one cluster', () => {
    // Each adjacent pair is above 0.6 while a~c is below it, so only
    // transitivity can produce a single cluster of three.
    const a = row('global', 'a', 'one two three four five six');
    const b = row('global', 'b', 'one two three four five seven');
    const c = row('global', 'c', 'one two three four seven eight');
    expect(similarity(a.value, c.value)).toBeLessThan(0.6);
    const clusters = clusterDuplicates([a, b, c], 0.6);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
  });

  it('reports the weakest and strongest surviving links', () => {
    const clusters = clusterDuplicates(
      [
        row('global', 'a', 'one two three four five six'),
        row('global', 'b', 'one two three four five seven'),
        row('global', 'c', 'one two three four seven eight'),
      ],
      0.6,
    );
    const { minSimilarity, maxSimilarity } = clusters[0];
    expect(minSimilarity).toBeGreaterThanOrEqual(0.6);
    expect(maxSimilarity).toBeGreaterThanOrEqual(minSimilarity);
  });

  it('sorts largest cluster first', () => {
    const clusters = clusterDuplicates([
      row('global', 'a', 'alpha beta gamma delta'),
      row('global', 'b', 'alpha beta gamma delta'),
      row('global', 'c', 'alpha beta gamma delta'),
      row('global', 'd', 'zulu yankee xray whiskey'),
      row('global', 'e', 'zulu yankee xray whiskey'),
    ]);
    expect(clusters.map((c) => c.size)).toEqual([3, 2]);
  });

  it('does not mutate its input', () => {
    const entries = [
      row('global', 'a', 'alpha beta gamma delta'),
      row('global', 'b', 'alpha beta gamma delta'),
    ];
    const snapshot = JSON.parse(JSON.stringify(entries));
    clusterDuplicates(entries);
    expect(entries).toEqual(snapshot);
  });
});

describe('clusterDuplicatesBlocked', () => {
  /**
   * THE equivalence property, and the reason `clusterDuplicates` is kept in the
   * module at all: the inverted-index optimisation must not change a single
   * cluster. Asserted over a spread of shapes and thresholds rather than one
   * happy path, because the failure mode is a MISSING cluster (a candidate pair
   * never generated), which a single-fixture test is unlikely to expose.
   */
  const FIXTURES = [
    row('global', 'a', 'alpha beta gamma delta epsilon'),
    row('global', 'b', 'alpha beta gamma delta epsilon'),
    row('global', 'c', 'alpha beta gamma delta zeta'),
    row('repo::x/y', 'd', 'one two three four five six'),
    row('repo::x/y', 'e', 'one two three four five seven'),
    row('repo::x/y', 'f', 'one two three four seven eight'),
    row('project::p', 'g', 'entirely different vocabulary altogether'),
    row('project::p', 'h', ''),
    row('project::p', 'i', ''),
    row('branch::x/y::main', 'j', 'ALPHA! BETA? gamma; delta: epsilon'),
  ];

  const shape = (clusters: ReturnType<typeof clusterDuplicates>) =>
    clusters
      .map((c) => ({
        keys: c.members.map((m) => m.key).sort(),
        size: c.size,
        min: Number(c.minSimilarity.toFixed(10)),
        max: Number(c.maxSimilarity.toFixed(10)),
      }))
      .sort((a, b) => a.keys.join(',').localeCompare(b.keys.join(',')));

  it.each([0.5, 0.6, 0.7, 0.8, 0.9, 1])(
    'produces clusters identical to the all-pairs reference at threshold %s',
    (threshold) => {
      expect(shape(clusterDuplicatesBlocked(FIXTURES, threshold))).toEqual(
        shape(clusterDuplicates(FIXTURES, threshold)),
      );
    },
  );

  it('clusters two empty bodies together (the similarity=1 edge)', () => {
    const clusters = clusterDuplicatesBlocked([
      row('global', 'h', ''),
      row('global', 'i', ''),
      row('global', 'j', 'real content with actual words'),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members.map((m) => m.key).sort()).toEqual(['h', 'i']);
  });

  it('carries the full member row through, not just scope+key', () => {
    const clusters = clusterDuplicatesBlocked([
      row('global', 'a', 'alpha beta gamma delta', 7),
      row('global', 'b', 'alpha beta gamma delta', 4),
    ]);
    expect(clusters[0].members.map((m) => m.seenCount).sort()).toEqual([4, 7]);
  });

  it('is total — a null value on a row degrades instead of throwing', () => {
    expect(() =>
      clusterDuplicatesBlocked([
        { scope: 'global', key: 'a', value: null, seenCount: null },
        { scope: 'global', key: 'b', value: undefined, seenCount: 1 },
      ]),
    ).not.toThrow();
  });
});

describe('RECURRENCE_CLUSTERS', () => {
  it('has a unique id and lessonKey per class', () => {
    expect(new Set(RECURRENCE_CLUSTERS.map((c) => c.id)).size).toBe(RECURRENCE_CLUSTERS.length);
    expect(new Set(RECURRENCE_CLUSTERS.map((c) => c.lessonKey)).size).toBe(
      RECURRENCE_CLUSTERS.length,
    );
  });

  it('gives every class a non-trivial name and why', () => {
    for (const cl of RECURRENCE_CLUSTERS) {
      expect(cl.name.length, `${cl.id} needs a shape`).toBeGreaterThan(20);
      expect(cl.why.length, `${cl.id} needs a why`).toBeGreaterThan(40);
    }
  });
});

describe('resolveRecurrenceClass', () => {
  const known = RECURRENCE_CLUSTERS[0];
  const other = RECURRENCE_CLUSTERS[1];

  it('returns the null shape when nothing resolves', () => {
    expect(resolveRecurrenceClass([{ key: 'nope::nothing' }])).toEqual({
      classId: null,
      className: null,
      matched: [],
      pure: false,
    });
  });

  it('returns the null shape for no members at all', () => {
    expect(resolveRecurrenceClass([]).classId).toBeNull();
    expect(resolveRecurrenceClass().pure).toBe(false);
  });

  it('is PURE when every member resolves to the same class', () => {
    const res = resolveRecurrenceClass([{ key: known.lessonKey }]);
    expect(res.classId).toBe(known.id);
    expect(res.className).toBe(known.name);
    expect(res.pure).toBe(true);
  });

  it('is NOT pure when a member fails to resolve', () => {
    const res = resolveRecurrenceClass([{ key: known.lessonKey }, { key: 'unknown::thing' }]);
    expect(res.classId).toBe(known.id);
    expect(res.matched).toEqual([known.lessonKey]);
    expect(res.pure).toBe(false);
  });

  it('is NOT pure when members split across two classes', () => {
    const res = resolveRecurrenceClass([{ key: known.lessonKey }, { key: other.lessonKey }]);
    expect(res.pure).toBe(false);
    // Tie on count -> registry order decides, deterministically.
    expect(res.classId).toBe(known.id);
    expect(res.matched).toHaveLength(2);
  });

  it('resolves through sourceKeys as well as the canonical lessonKey', () => {
    const registry = [{ ...known, sourceKeys: ['alias::key'] }];
    const res = resolveRecurrenceClass([{ key: 'alias::key' }], registry);
    expect(res.classId).toBe(known.id);
    expect(res.pure).toBe(true);
  });

  it('ignores members with no usable key rather than counting them', () => {
    const res = resolveRecurrenceClass([{ key: known.lessonKey }, { key: '' }, { key: null }]);
    expect(res.matched).toEqual([known.lessonKey]);
    // Three members, one match -> not pure. An implementation that skipped the
    // unusable rows from the DENOMINATOR too would wrongly report pure.
    expect(res.pure).toBe(false);
  });
});

describe('parseMetaComment', () => {
  it('extracts bare and quoted fields', () => {
    const meta = parseMetaComment(
      '<!-- meta: phase=7 seen_count=3 status=active trigger-context="a b c" -->\nbody',
    );
    expect(meta).toMatchObject({
      phase: '7',
      seen_count: '3',
      status: 'active',
      'trigger-context': 'a b c',
    });
  });

  // The exact regression PR #608's follow-up commit fixed: a `>` inside the
  // comment body used to abort the whole parse.
  it('tolerates a `>` inside a quoted field', () => {
    const meta = parseMetaComment('<!-- meta: seen_count=2 trigger-context="length > 0" -->');
    expect(meta['seen_count']).toBe('2');
    expect(meta['trigger-context']).toBe('length > 0');
  });

  it('unescapes an embedded quote', () => {
    expect(parseMetaComment('<!-- meta: t="say \\"hi\\"" -->')['t']).toBe('say "hi"');
  });

  it('is total — no comment, a malformed comment, or a non-string yields {}', () => {
    expect(parseMetaComment('no meta here')).toEqual({});
    expect(parseMetaComment('<!-- meta: unterminated')).toEqual({});
    expect(parseMetaComment(null)).toEqual({});
    expect(parseMetaComment(42)).toEqual({});
  });

  it('takes the FIRST meta comment when there are several', () => {
    expect(parseMetaComment('<!-- meta: a=1 -->x<!-- meta: a=2 -->')['a']).toBe('1');
  });
});

describe('isCandidate', () => {
  it('qualifies on the SUMMED seenCount, not any single member', () => {
    const members = [row('global', 'a', 'x', 2), row('global', 'b', 'x', 1)];
    expect(isCandidate(members)).toBe(true);
    expect(isCandidate([row('global', 'a', 'x', 2)])).toBe(false);
  });

  it('respects an explicit minSeenCount', () => {
    const members = [row('global', 'a', 'x', 1), row('global', 'b', 'x', 1)];
    expect(isCandidate(members, { minSeenCount: 2 })).toBe(true);
    expect(isCandidate(members, { minSeenCount: 5 })).toBe(false);
  });

  it('qualifies on a non-active declared status alone, however few sightings', () => {
    const members = [row('global', 'a', '<!-- meta: status=structural -->', 1)];
    expect(isCandidate(members)).toBe(true);
  });

  it('does NOT qualify on an explicitly active status', () => {
    expect(isCandidate([row('global', 'a', '<!-- meta: status=active -->', 1)])).toBe(false);
  });

  it('treats a missing seenCount as zero rather than NaN-poisoning the sum', () => {
    const members = [row('global', 'a', 'x', null), row('global', 'b', 'x', 5)];
    expect(isCandidate(members)).toBe(true);
  });

  it('defaults minSeenCount to the documented constant', () => {
    expect(DEFAULT_MIN_SEEN_COUNT).toBe(3);
    expect(isCandidate([row('global', 'a', 'x', 3)])).toBe(true);
  });
});

describe('scoreCandidate', () => {
  it('multiplies recurrence by distinct scopes', () => {
    expect(
      scoreCandidate([row('global', 'a', 'x', 3), row('repo::x/y', 'b', 'x', 3)]),
    ).toBe(12);
  });

  it('scores a single-scope cluster lower than the same sightings spread out', () => {
    const oneScope = [row('global', 'a', 'x', 3), row('global', 'b', 'x', 3)];
    const twoScopes = [row('global', 'a', 'x', 3), row('repo::x/y', 'b', 'x', 3)];
    expect(scoreCandidate(oneScope)).toBeLessThan(scoreCandidate(twoScopes));
  });

  it('is 0 when nothing has recurred', () => {
    expect(scoreCandidate([row('global', 'a', 'x', 0)])).toBe(0);
  });
});

describe('rankCandidates', () => {
  const cluster = (
    members: ReturnType<typeof row>[],
    min = 0.8,
    max = 0.9,
  ) => ({ members, size: members.length, minSimilarity: min, maxSimilarity: max });

  it('drops clusters that are not candidates', () => {
    const ranked = rankCandidates([cluster([row('global', 'a', 'x', 1)])]);
    expect(ranked).toEqual([]);
  });

  it('orders by score descending', () => {
    const weak = cluster([row('global', 'a', 'x', 2), row('global', 'b', 'x', 2)]);
    const strong = cluster([row('global', 'c', 'x', 5), row('repo::x/y', 'd', 'x', 5)]);
    const ranked = rankCandidates([weak, strong]);
    expect(ranked.map((r) => r.score)).toEqual([20, 4]);
  });

  it('breaks a score tie by size, then by the first scope::key', () => {
    // Both score 6: one is 3 members x 1 scope x 2 seen, the other 2 x 1 x 3.
    const three = cluster([
      row('global', 'm', 'x', 2),
      row('global', 'n', 'x', 2),
      row('global', 'o', 'x', 2),
    ]);
    const two = cluster([row('global', 'a', 'x', 3), row('global', 'b', 'x', 3)]);
    const ranked = rankCandidates([two, three]);
    expect(ranked.map((r) => r.score)).toEqual([6, 6]);
    expect(ranked[0].size).toBe(3);
  });

  it('is deterministic for two fully tied clusters', () => {
    const first = cluster([row('global', 'aaa', 'x', 3)]);
    const second = cluster([row('global', 'bbb', 'x', 3)]);
    expect(rankCandidates([second, first]).map((r) => r.members[0].key)).toEqual(['aaa', 'bbb']);
    expect(rankCandidates([first, second]).map((r) => r.members[0].key)).toEqual(['aaa', 'bbb']);
  });

  it('attaches the parsed meta to every member', () => {
    const ranked = rankCandidates([
      cluster([row('global', 'a', '<!-- meta: status=structural -->', 1)]),
    ]);
    expect(ranked[0].members[0].meta['status']).toBe('structural');
  });

  it('preserves the similarity range from the input cluster', () => {
    const ranked = rankCandidates([cluster([row('global', 'a', 'x', 3)], 0.71, 0.93)]);
    expect(ranked[0].minSimilarity).toBeCloseTo(0.71, 10);
    expect(ranked[0].maxSimilarity).toBeCloseTo(0.93, 10);
  });

  it('leaves recurrenceClass null when no resolver is supplied', () => {
    expect(rankCandidates([cluster([row('global', 'a', 'x', 3)])])[0].recurrenceClass).toBeNull();
  });

  it('calls the injected resolver with the RAW members', () => {
    const seen: unknown[] = [];
    rankCandidates([cluster([row('global', 'a', 'x', 3)])], {
      resolveClass: (members) => {
        seen.push(members);
        return { classId: 'x', className: 'X', matched: [], pure: false };
      },
    });
    expect(seen).toHaveLength(1);
    // The raw member, without the `meta` field the ranked copy gains.
    expect((seen[0] as { meta?: unknown }[])[0].meta).toBeUndefined();
  });

  it('does not mutate the input clusters', () => {
    const input = [cluster([row('global', 'a', 'x', 3)])];
    const snapshot = JSON.parse(JSON.stringify(input));
    rankCandidates(input);
    expect(input).toEqual(snapshot);
  });

  it('is total — undefined input yields an empty ranking', () => {
    expect(rankCandidates()).toEqual([]);
  });
});
