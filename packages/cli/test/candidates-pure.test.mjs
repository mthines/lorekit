// `candidates-pure.mjs` — the pure scoring/ranking core behind
// `lorekit invariants candidates`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMetaComment,
  statusOf,
  appliesWhenOf,
  isCandidate,
  scoreCandidate,
  rankCandidates,
} from '../src/shared/candidates-pure.mjs';

describe('statusOf', () => {
  test('reads the canonical `status::<value>` tag', () => {
    assert.equal(statusOf({ tags: ['loop::aw-lessons', 'status::structural'], value: '# t' }), 'structural');
  });

  test('falls back to a legacy meta comment when no status tag is present', () => {
    assert.equal(statusOf({ tags: ['loop::aw-lessons'], value: '<!-- meta: status=promoted -->' }), 'promoted');
  });

  test('the tag wins over a legacy meta comment that disagrees', () => {
    const m = { tags: ['status::promoted'], value: '<!-- meta: status=active -->' };
    assert.equal(statusOf(m), 'promoted');
  });

  test('a lesson declaring no status anywhere yields the empty string, never a throw', () => {
    assert.equal(statusOf({ tags: ['loop::aw-lessons'], value: '# a clean markdown lesson' }), '');
    assert.equal(statusOf({}), '');
    assert.equal(statusOf(null), '');
    assert.equal(statusOf({ tags: 'not-an-array', value: 42 }), '');
  });

  test('a bare `status::` tag carries no value and is ignored', () => {
    assert.equal(statusOf({ tags: ['status::'], value: '' }), '');
  });
});

describe('appliesWhenOf', () => {
  test('reads the canonical visible `**Applies when:**` line', () => {
    const value = '# Pass --node-modules-dir=none\n\n**Applies when:** running `deno check` locally\n\n**Why:** x';
    assert.equal(appliesWhenOf({ value }), 'running `deno check` locally');
  });

  test('falls back to a legacy meta comment `trigger-context`', () => {
    const value = '<!-- meta: trigger-context="file glob: **/*.ts" -->\n\n# title';
    assert.equal(appliesWhenOf({ value }), 'file glob: **/*.ts');
  });

  test('the visible line wins over a legacy meta comment', () => {
    const value = '<!-- meta: trigger-context="old" -->\n\n# t\n\n**Applies when:** new';
    assert.equal(appliesWhenOf({ value }), 'new');
  });

  // Every fixture above is single-line, which is exactly how the truncation bug
  // survived: markdown prose wraps, and the skill's own worked example wraps.
  test('a WRAPPED applies-when paragraph is returned whole, re-flowed to one line', () => {
    const value =
      '# Take the heredoc form\n\n' +
      '**Applies when:** shelling out to `slackSendMessage` with text interpolated from\n' +
      'a ticket title that may contain backticks or apostrophes\n\n' +
      '**Why:** the shell re-interprets them';
    assert.equal(
      appliesWhenOf({ value }),
      'shelling out to `slackSendMessage` with text interpolated from a ticket title that may contain backticks or apostrophes',
    );
  });

  test('the paragraph stops at a blank line or the next bold label, never running into the body', () => {
    assert.equal(appliesWhenOf({ value: '**Applies when:** alpha beta\n**Why:** not this' }), 'alpha beta');
    assert.equal(appliesWhenOf({ value: '**Applies when:** alpha\n\nloose body text' }), 'alpha');
    assert.equal(appliesWhenOf({ value: '**Applies when:** a\nb\nc\n\n**Why:** no' }), 'a b c');
  });

  // The stop condition is a bold LABEL, not merely bold. A continuation line
  // opening with an inline bold token is prose, and ending the paragraph there
  // is the same truncation one wrap further in.
  test('a continuation line starting with an inline bold token is not a stop', () => {
    const value = '# T\n\n**Applies when:** you touch\n**foo()** in the parser.\n\n**Why:** x';
    assert.equal(appliesWhenOf({ value }), 'you touch **foo()** in the parser.');
  });

  test('a real bold label still stops the paragraph', () => {
    assert.equal(appliesWhenOf({ value: '**Applies when:** alpha\n**Why:** no' }), 'alpha');
    assert.equal(appliesWhenOf({ value: '**Applies when:** alpha\n**Do this instead:** no' }), 'alpha');
  });

  // A label's colon is written both inside and outside the bold in the wild.
  // Recognising only one spelling swaps early truncation for an overrun, which
  // is the same defect pointing the other way.
  test('a label whose colon sits OUTSIDE the bold also stops the paragraph', () => {
    assert.equal(appliesWhenOf({ value: '**Applies when:** alpha\n**Why**: no' }), 'alpha');
    assert.equal(appliesWhenOf({ value: '**Applies when:** alpha\n**Do this instead**: no' }), 'alpha');
  });

  test('the opener is read in either colon spelling', () => {
    assert.equal(appliesWhenOf({ value: '**Applies when**: x\n**Why:** no' }), 'x');
  });

  test('a trailing paragraph with no blank line after it is still read', () => {
    assert.equal(appliesWhenOf({ value: '# T\n\n**Applies when:** trailing, at EOF' }), 'trailing, at EOF');
  });

  test('the label must open a line — an inline mention is not a declaration', () => {
    assert.equal(appliesWhenOf({ value: 'prose mentioning **Applies when:** inline' }), '');
  });

  test('a lesson declaring neither yields the empty string, never a throw', () => {
    assert.equal(appliesWhenOf({ value: '# just a title' }), '');
    assert.equal(appliesWhenOf({}), '');
    assert.equal(appliesWhenOf(null), '');
    assert.equal(appliesWhenOf({ value: 42 }), '');
  });
});

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

  test('a `>` inside the meta comment body (e.g. a trigger-context guard) does not truncate the match', () => {
    const meta = parseMetaComment('<!-- meta: seen_count=1 trigger-context="length > 0" -->\n\n# title');
    assert.equal(meta.seen_count, '1');
    assert.equal(meta['trigger-context'], 'length > 0');
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

  test('a `status::structural` TAG qualifies a hidden-block-free lesson', () => {
    const members = [{ seenCount: 1, tags: ['loop::aw-lessons', 'status::structural'], value: '# clean markdown' }];
    assert.equal(isCandidate(members, { minSeenCount: 3 }), true);
  });

  test('a `status::active` tag does not itself qualify', () => {
    const members = [{ seenCount: 1, tags: ['status::active'], value: '# clean markdown' }];
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

  test('attaches the resolved status and applies-when per member, from tags and visible prose', () => {
    const cluster = {
      members: [
        {
          scope: 'global',
          key: 'clean-a',
          seenCount: 4,
          tags: ['status::structural'],
          value: '# Take the heredoc form\n\n**Applies when:** a message body may contain backticks',
        },
      ],
      size: 1,
    };
    const [ranked] = rankCandidates([cluster], { minSeenCount: 3 });
    assert.equal(ranked.members[0].status, 'structural');
    assert.equal(ranked.members[0].appliesWhen, 'a message body may contain backticks');
    assert.deepEqual(ranked.members[0].meta, {}, 'a clean lesson carries no meta comment at all');
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
