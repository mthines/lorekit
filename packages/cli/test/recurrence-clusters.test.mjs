// `recurrence-clusters.mjs` — the named classes map entries instantiate, and
// `resolveRecurrenceClass`, the join a `dedupe` cluster's members resolve
// through to recognize an already-named class.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECURRENCE_CLUSTERS,
  clusterById,
  clusterForLessonKey,
  resolveRecurrenceClass,
} from '../src/shared/recurrence-clusters.mjs';

describe('clusterById / clusterForLessonKey', () => {
  test('resolves a known cluster; an unknown id/key is null, not a throw', () => {
    const first = RECURRENCE_CLUSTERS[0];
    assert.equal(clusterById(first.id), first);
    assert.equal(clusterById('nope'), null);
    assert.equal(clusterById(undefined), null);
    assert.equal(clusterForLessonKey(first.lessonKey), first);
    assert.equal(clusterForLessonKey('nope::nope'), null);
    assert.equal(clusterForLessonKey(undefined), null);
  });
});

describe('resolveRecurrenceClass', () => {
  const FAKE_CLUSTERS = [
    { id: 'alpha', name: 'Alpha class', lessonKey: 'k::alpha-canon', why: 'because alpha', sourceKeys: ['k::alpha-1', 'k::alpha-2'] },
    { id: 'beta', name: 'Beta class', lessonKey: 'k::beta-canon', why: 'because beta', sourceKeys: [] },
  ];

  test('no members → the null shape, not a throw', () => {
    assert.deepEqual(resolveRecurrenceClass([], FAKE_CLUSTERS), { classId: null, className: null, matched: [], pure: false });
    assert.deepEqual(resolveRecurrenceClass(undefined, FAKE_CLUSTERS), { classId: null, className: null, matched: [], pure: false });
  });

  test('no member key resolves to any class → the null shape', () => {
    const r = resolveRecurrenceClass([{ scope: 'global', key: 'k::unrelated' }], FAKE_CLUSTERS);
    assert.deepEqual(r, { classId: null, className: null, matched: [], pure: false });
  });

  test('every member resolves to the same class via sourceKeys → pure', () => {
    const members = [
      { scope: 'global', key: 'k::alpha-1' },
      { scope: 'repo::x/y', key: 'k::alpha-2' },
    ];
    const r = resolveRecurrenceClass(members, FAKE_CLUSTERS);
    assert.equal(r.classId, 'alpha');
    assert.equal(r.className, 'Alpha class');
    assert.deepEqual(r.matched.sort(), ['k::alpha-1', 'k::alpha-2']);
    assert.equal(r.pure, true);
  });

  test('a member key equal to the canonical lessonKey resolves too, not just sourceKeys', () => {
    const r = resolveRecurrenceClass([{ scope: 'global', key: 'k::alpha-canon' }], FAKE_CLUSTERS);
    assert.equal(r.classId, 'alpha');
    assert.equal(r.pure, true);
  });

  test('a partial match (one member resolves, one does not) reports the class but pure:false', () => {
    const members = [
      { scope: 'global', key: 'k::alpha-1' },
      { scope: 'global', key: 'k::some-other-variant' },
    ];
    const r = resolveRecurrenceClass(members, FAKE_CLUSTERS);
    assert.equal(r.classId, 'alpha');
    assert.deepEqual(r.matched, ['k::alpha-1']);
    assert.equal(r.pure, false);
  });

  test('a split across two classes reports the majority, ties broken by registry order', () => {
    const tie = [
      { scope: 'global', key: 'k::beta-canon' },
      { scope: 'global', key: 'k::alpha-1' },
    ];
    // Equal counts (1 each) — the registry lists alpha first, so alpha wins the tie.
    const r = resolveRecurrenceClass(tie, FAKE_CLUSTERS);
    assert.equal(r.classId, 'alpha');
    assert.equal(r.pure, false, 'members split across two classes is never pure');

    const majority = [
      { scope: 'global', key: 'k::alpha-1' },
      { scope: 'global', key: 'k::alpha-2' },
      { scope: 'global', key: 'k::beta-canon' },
    ];
    const rMajority = resolveRecurrenceClass(majority, FAKE_CLUSTERS);
    assert.equal(rMajority.classId, 'alpha');
    assert.equal(rMajority.pure, false);
  });

  test('a member with no string key is skipped rather than throwing', () => {
    const members = [{ scope: 'global', key: null }, { scope: 'global' }, { scope: 'global', key: 'k::alpha-canon' }];
    const r = resolveRecurrenceClass(members, FAKE_CLUSTERS);
    assert.equal(r.classId, 'alpha');
    assert.deepEqual(r.matched, ['k::alpha-canon']);
  });

  test('defaults to the real RECURRENCE_CLUSTERS registry when no clusters arg is given', () => {
    const real = RECURRENCE_CLUSTERS[0];
    const r = resolveRecurrenceClass([{ scope: 'global', key: real.lessonKey }]);
    assert.equal(r.classId, real.id);
  });
});
