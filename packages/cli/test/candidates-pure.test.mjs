// `candidates-pure.mjs` — the pure scoring/ranking core behind
// `lorekit invariants candidates`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseMetaComment, isCandidate, scoreCandidate, rankCandidates } from '../src/shared/candidates-pure.mjs';

describe('parseMetaComment', () => {
  test('extracts fields from the documented meta-comment convention', () => {
    const value = '<!-- meta: seen_count=1 status=active trigger-context="file glob: **/*.ts" -->\n\n# title';
    const meta = parseMetaComment(value);
    assert.equal(meta.seen_count, '1');
    assert.equal(meta.status, 'active');
    assert.equal(meta['trigger-context'], 'file glob: **/*.ts');
  });

  test('no meta comment, non-string, or malformed input degrades to {} rather than throwing', () => {
    assert.deepEqual(parseMetaComment('just a plain lesson, no comment'), {});
    assert.deepEqual(parseMetaComment(''), {});
    assert.deepEqual(parseMetaComment(null), {});
    assert.deepEqual(parseMetaComment(undefined), {});
    assert.deepEqual(parseMetaComment(42), {});
  });

  test('handles an escaped quote inside a quoted field', () => {
    const meta = parseMetaComment('<!-- meta: trigger-context="says \\"hello\\" to it" -->');
    assert.equal(meta['trigger-context'], 'says "hello" to it');
  });
});

describe('isCandidate', () => {
  test('summed seen_count across members at/above the threshold is a candidate', () => {
    const members = [{ seenCount: 2, value: '' }, { seenCount: 1, value: '' }];
    assert.equal(isCandidate(members, { minSeenCount: 3 }), true);
    assert.equal(isCandidate(members, { minSeenCount: 4 }), false);
  });

  test('a non-"active" status makes a cluster a candidate regardless of seen_count', () => {
    const members = [{ seenCount: 1, value: '<!-- meta: status=structural -->' }];
    assert.equal(isCandidate(members, { minSeenCount: 3 }), true);
  });

  test('an explicit status=active does not itself qualify', () => {
    const members = [{ seenCount: 1, value: '<!-- meta: status=active -->' }];
    assert.equal(isCandidate(members, { minSeenCount: 3 }), false);
  });

  test('no members is never a candidate', () => {
    assert.equal(isCandidate([], { minSeenCount: 3 }), false);
    assert.equal(isCandidate(undefined, { minSeenCount: 3 }), false);
  });
});

describe('scoreCandidate', () => {
  test('recurrence (summed seen_count) × distinct scopes', () => {
    const members = [
      { scope: 'global', seenCount: 3 },
      { scope: 'repo::x/y', seenCount: 2 },
    ];
    assert.equal(scoreCandidate(members), 5 * 2);
  });

  test('members in the same scope do not inflate the distinct-scope multiplier', () => {
    const members = [
      { scope: 'global', seenCount: 2 },
      { scope: 'global', seenCount: 2 },
    ];
    assert.equal(scoreCandidate(members), 4 * 1);
  });
});

describe('rankCandidates', () => {
  const lowCluster = { members: [{ scope: 'global', key: 'low-a', seenCount: 1, value: '' }, { scope: 'global', key: 'low-b', seenCount: 1, value: '' }], size: 2 };
  const highCluster = {
    members: [
      { scope: 'global', key: 'high-a', seenCount: 4, value: '' },
      { scope: 'repo::x/y', key: 'high-b', seenCount: 3, value: '' },
    ],
    size: 2,
  };
  const structuralCluster = {
    members: [
      { scope: 'global', key: 'struct-a', seenCount: 1, value: '<!-- meta: status=structural -->' },
      { scope: 'global', key: 'struct-b', seenCount: 1, value: '' },
    ],
    size: 2,
  };

  test('filters to candidates only and ranks by score descending', () => {
    const ranked = rankCandidates([lowCluster, highCluster, structuralCluster], { minSeenCount: 3 });
    assert.equal(ranked.length, 2, 'lowCluster (summed seen_count 2, no non-active status) should not qualify');
    assert.equal(ranked[0].members[0].key, 'high-a', 'the higher-scoring cluster ranks first');
    assert.ok(ranked[0].score > ranked[1].score);
  });

  test('never mutates the input clusters', () => {
    const before = JSON.parse(JSON.stringify(highCluster));
    rankCandidates([highCluster], { minSeenCount: 3 });
    assert.deepEqual(highCluster, before);
  });

  test('attaches parsed meta per member and the resolved recurrence class when a resolver is given', () => {
    const resolveClass = (members) => ({ classId: 'fake-class', className: 'Fake', matched: members.map((m) => m.key), pure: true });
    const ranked = rankCandidates([structuralCluster], { minSeenCount: 3, resolveClass });
    assert.equal(ranked[0].members[0].meta.status, 'structural');
    assert.equal(ranked[0].recurrenceClass.classId, 'fake-class');
  });

  test('recurrenceClass is null when no resolver is supplied', () => {
    const ranked = rankCandidates([highCluster], { minSeenCount: 3 });
    assert.equal(ranked[0].recurrenceClass, null);
  });

  test('an empty or undefined cluster list returns an empty array, not a throw', () => {
    assert.deepEqual(rankCandidates([], {}), []);
    assert.deepEqual(rankCandidates(undefined, {}), []);
  });
});
