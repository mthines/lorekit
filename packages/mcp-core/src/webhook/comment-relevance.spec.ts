import { describe, it, expect } from 'vitest';
import {
  DECLINE_PATTERN,
  LINE_TOUCH_RADIUS,
  SAFE_MARKER_VALUE,
  patchTouchesLine,
  buildRelevanceKey,
  buildRelevanceRecord,
  classifyMergedThread,
  classifyResolvedThread,
  extractMarkerValue,
  hasDeclineReply,
  isSafeMarkerValue,
  touchEvidenceFromFiles,
  type ComparedFile,
  type RelevanceRecordVerdict,
  type ThreadFacts,
} from './comment-relevance.js';

const OPEN = '<!-- fp:v2:';
const CLOSE = '-->';

/** A thread with nothing decided: live anchor, no replies, no reaction, untouched. */
function facts(overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return {
    state: { isResolved: false, isOutdated: false },
    replies: [],
    thumbsDownBy: null,
    path: 'src/app.ts',
    line: 42,
    touch: { touched: false, granularity: 'line' },
    ...overrides,
  };
}

describe('hasDeclineReply', () => {
  it.each([
    "won't fix",
    'wont fix',
    'This is by design',
    'That was intentional',
    'not going to change this',
    'nwf',
    'n/a',
    'out of scope for this PR',
    'as designed',
    'working as intended',
  ])('detects a decline in %j', (body) => {
    expect(hasDeclineReply([body])).toBe(true);
  });

  it('detects a decline in any reply, not only the first', () => {
    expect(hasDeclineReply(['thanks', 'good catch', 'actually this is by design'])).toBe(true);
  });

  it('returns false for an empty reply list', () => {
    expect(hasDeclineReply([])).toBe(false);
  });

  it('tolerates a null-ish body without throwing', () => {
    expect(hasDeclineReply([undefined as unknown as string])).toBe(false);
  });

  // Each of these is a real inversion: an acknowledged, LANDED fix recorded as a
  // decline because one alternative was unbounded. They are asserted one by one
  // rather than as a group so a regression names the alternative that broke.
  describe('word boundaries — an ordinary "fixed it" reply is never a decline', () => {
    it.each([
      ['unintentional', 'That was unintentional - fixed'],
      ['by designers', 'Reviewed by designers, then fixed'],
      ['path fragment', 'Fixed, see src/bin/a.js'],
      ['was designed', 'This was designed upstream - fixed'],
      ['wont fixate', 'I wont fixate on this, addressed it'],
      ['longer token than nwf', 'Handled in the nwfoo helper'],
    ])('%s does not match', (_label, body) => {
      expect(hasDeclineReply([body])).toBe(false);
    });
  });

  it('DECLINE_PATTERN is not global, so repeated tests do not alternate', () => {
    // A /g regex carries lastIndex between .test() calls and would return
    // false on every second identical body.
    expect(DECLINE_PATTERN.global).toBe(false);
    expect(DECLINE_PATTERN.test('by design')).toBe(true);
    expect(DECLINE_PATTERN.test('by design')).toBe(true);
  });
});

describe('isSafeMarkerValue', () => {
  it.each([
    'correctness:null-deref:handleRequest@src/api/handler.ts',
    'a',
    'A.b_c-d:e@f/g',
  ])('accepts %j', (value) => {
    expect(isSafeMarkerValue(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a space', 'correctness:null deref@src/a.ts'],
    ['a newline', 'a\nb'],
    ['a quote', 'a"b'],
    ['a backtick', 'a`b'],
    ['a comma (PostgREST filter grammar)', 'a,b'],
    ['a parenthesis', 'a(b)'],
    ['a percent sign', 'a%b'],
  ])('rejects %s', (_label, value) => {
    expect(isSafeMarkerValue(value)).toBe(false);
  });

  it('rejects a value longer than 200 characters', () => {
    expect(isSafeMarkerValue('a'.repeat(200))).toBe(true);
    expect(isSafeMarkerValue('a'.repeat(201))).toBe(false);
  });

  it('SAFE_MARKER_VALUE is anchored at both ends', () => {
    // Unanchored, "ok value\n<script>" would pass on its first line.
    expect(SAFE_MARKER_VALUE.source.startsWith('^')).toBe(true);
    expect(SAFE_MARKER_VALUE.source.endsWith('$')).toBe(true);
  });
});

describe('extractMarkerValue', () => {
  it('pulls the value out of a marker embedded in prose', () => {
    const body = `issue: this can be null.\n\n${OPEN}correctness:null-deref:handle@src/a.ts${CLOSE}`;
    expect(extractMarkerValue(body, OPEN, CLOSE)).toBe('correctness:null-deref:handle@src/a.ts');
  });

  it('trims surrounding whitespace inside the delimiters', () => {
    expect(extractMarkerValue(`${OPEN} abc ${CLOSE}`, OPEN, CLOSE)).toBe('abc');
  });

  it('returns null when the open delimiter is absent', () => {
    expect(extractMarkerValue('just a comment', OPEN, CLOSE)).toBeNull();
  });

  it('returns null when the close delimiter never follows the open one', () => {
    expect(extractMarkerValue(`${OPEN}abc`, OPEN, CLOSE)).toBeNull();
  });

  it('ignores a close delimiter that appears BEFORE the open one', () => {
    // indexOf(close) must start searching after the open delimiter, or an
    // arrow earlier in the prose truncates the search to an empty value.
    expect(extractMarkerValue(`a --> b ${OPEN}abc${CLOSE}`, OPEN, CLOSE)).toBe('abc');
  });

  it('returns null — not a partial — when the value fails the charset check', () => {
    expect(extractMarkerValue(`${OPEN}has a space${CLOSE}`, OPEN, CLOSE)).toBeNull();
  });

  it('returns null for an empty value between the delimiters', () => {
    expect(extractMarkerValue(`${OPEN}${CLOSE}`, OPEN, CLOSE)).toBeNull();
  });

  it('returns null for a missing body or empty delimiters', () => {
    expect(extractMarkerValue(null, OPEN, CLOSE)).toBeNull();
    expect(extractMarkerValue(undefined, OPEN, CLOSE)).toBeNull();
    expect(extractMarkerValue(`${OPEN}abc${CLOSE}`, '', CLOSE)).toBeNull();
    expect(extractMarkerValue(`${OPEN}abc${CLOSE}`, OPEN, '')).toBeNull();
  });

  it('takes the FIRST marker when a body carries two', () => {
    const body = `${OPEN}first${CLOSE} and ${OPEN}second${CLOSE}`;
    expect(extractMarkerValue(body, OPEN, CLOSE)).toBe('first');
  });
});

describe('buildRelevanceKey', () => {
  it('concatenates the prefix and the value with nothing in between', () => {
    expect(buildRelevanceKey('reviewer-comment-relevance::rule::', 'a:b:c@d.ts')).toBe(
      'reviewer-comment-relevance::rule::a:b:c@d.ts',
    );
  });

  it('returns null for an unsafe value rather than a key nobody can predict', () => {
    expect(buildRelevanceKey('p::', 'has a space')).toBeNull();
  });

  it('returns null for an empty prefix', () => {
    expect(buildRelevanceKey('', 'abc')).toBeNull();
  });
});

describe('patchTouchesLine', () => {
  const patch = '@@ -10,3 +10,5 @@\n-old\n+new\n+extra\n@@ -80,2 +82,2 @@\n-a\n+b';

  it('matches a line inside a hunk', () => {
    expect(patchTouchesLine(patch, 11)).toBe(true);
  });

  it('matches a line within the radius above a hunk', () => {
    // The hunk starts at 10, so with a radius of 10 anything from 1 upward is
    // inside it. Line 0 is not tested here — it is not a line, and the
    // non-positive case is asserted separately below.
    expect(patchTouchesLine(patch, 1, 10)).toBe(true);
    expect(patchTouchesLine(patch, 3)).toBe(true);
  });

  it('does not match a line beyond the radius', () => {
    expect(patchTouchesLine(patch, 40)).toBe(false);
  });

  it('matches the SECOND hunk, not just the first', () => {
    expect(patchTouchesLine(patch, 83)).toBe(true);
  });

  it('treats a header with no explicit length as one line', () => {
    // "@@ -1 +7 @@" is legal unified diff. Defaulting the count to 0 instead of
    // 1 makes a one-line fix invisible.
    expect(patchTouchesLine('@@ -1 +7 @@\n-a\n+b', 7, 0)).toBe(true);
  });

  it('respects a zero radius exactly', () => {
    expect(patchTouchesLine('@@ -10,1 +10,1 @@\n-a\n+b', 10, 0)).toBe(true);
    expect(patchTouchesLine('@@ -10,1 +10,1 @@\n-a\n+b', 30, 0)).toBe(false);
  });

  it('returns false for a missing patch or a non-positive line', () => {
    expect(patchTouchesLine(null, 5)).toBe(false);
    expect(patchTouchesLine(undefined, 5)).toBe(false);
    expect(patchTouchesLine(patch, 0)).toBe(false);
    expect(patchTouchesLine(patch, Number.NaN)).toBe(false);
  });

  it('ignores text that merely looks like a hunk header', () => {
    expect(patchTouchesLine('not a diff at all', 5)).toBe(false);
  });

  it('is re-runnable — matchAll never leaves state behind', () => {
    expect(patchTouchesLine(patch, 11)).toBe(true);
    expect(patchTouchesLine(patch, 11)).toBe(true);
  });

  it('LINE_TOUCH_RADIUS is the documented default', () => {
    expect(LINE_TOUCH_RADIUS).toBe(10);
    expect(patchTouchesLine(patch, 11)).toBe(patchTouchesLine(patch, 11, LINE_TOUCH_RADIUS));
  });
});

describe('touchEvidenceFromFiles', () => {
  const PATCH = '@@ -10,3 +10,5 @@\n-old\n+new';
  const files = (over: Partial<ComparedFile> = {}): ComparedFile[] => [
    { filename: 'src/a.ts', patch: PATCH, ...over },
  ];

  it('is undecidable when the walk did not complete', () => {
    expect(touchEvidenceFromFiles(null, 'src/a.ts', 11)).toBeNull();
    expect(touchEvidenceFromFiles(undefined, 'src/a.ts', 11)).toBeNull();
  });

  it('is undecidable with no path to corroborate against', () => {
    expect(touchEvidenceFromFiles(files(), null, 11)).toBeNull();
    expect(touchEvidenceFromFiles(files(), '', 11)).toBeNull();
  });

  it('reports untouched when a COMPLETED walk does not list the file', () => {
    // Different from an unreadable walk: every changed file was seen and this
    // was not one of them, which is real evidence that no fix landed.
    expect(touchEvidenceFromFiles(files(), 'src/other.ts', 11)).toEqual({
      touched: false,
      granularity: 'line',
    });
  });

  it('reports touched at line granularity when a hunk covers the line', () => {
    expect(touchEvidenceFromFiles(files(), 'src/a.ts', 11)).toEqual({
      touched: true,
      granularity: 'line',
    });
  });

  it('reports untouched when the hunks are outside the radius', () => {
    expect(touchEvidenceFromFiles(files(), 'src/a.ts', 500)).toEqual({
      touched: false,
      granularity: 'line',
    });
  });

  it('treats a rename as a touch, matching previous_filename', () => {
    const renamed = [{ filename: 'src/b.ts', previous_filename: 'src/a.ts', patch: PATCH }];
    expect(touchEvidenceFromFiles(renamed, 'src/a.ts', 11)).toEqual({
      touched: true,
      granularity: 'line',
    });
  });

  describe('an absent patch is UNDECIDABLE, never untouched', () => {
    // The regression this function exists to prevent: `compare` omits `patch`
    // for a binary file, an over-limit diff, and a pure rename. Reading that as
    // `touched: false` files an `ignored-at-merge` suppression for a file the
    // pull request demonstrably changed.
    it('returns null when the listed entry carries no patch', () => {
      expect(touchEvidenceFromFiles([{ filename: 'src/a.ts' }], 'src/a.ts', 11)).toBeNull();
    });

    it('returns null for an explicitly null or empty patch', () => {
      expect(touchEvidenceFromFiles([{ filename: 'src/a.ts', patch: null }], 'src/a.ts', 11)).toBeNull();
      expect(touchEvidenceFromFiles([{ filename: 'src/a.ts', patch: '' }], 'src/a.ts', 11)).toBeNull();
    });

    it('returns null for a pure rename with no patch, at line granularity', () => {
      const renamed = [{ filename: 'src/b.ts', previous_filename: 'src/a.ts' }];
      expect(touchEvidenceFromFiles(renamed, 'src/a.ts', 11)).toBeNull();
    });

    it('and the merged classifier turns that null into no record at all', () => {
      const verdict = classifyMergedThread(
        facts({ path: 'src/a.ts', line: 11, touch: null }),
      );
      expect(verdict.write).toBe(false);
      expect(verdict).toMatchObject({ skip: 'touch-undecidable' });
    });
  });

  describe('file granularity — no line anchor', () => {
    it('a listed file is touched, patch or not', () => {
      // The file-level question is the honest weaker one and needs no hunks, so
      // a missing patch is not undecidable here.
      expect(touchEvidenceFromFiles([{ filename: 'src/a.ts' }], 'src/a.ts', null)).toEqual({
        touched: true,
        granularity: 'file',
      });
      expect(touchEvidenceFromFiles(files(), 'src/a.ts', 0)).toEqual({
        touched: true,
        granularity: 'file',
      });
    });

    it('an unlisted file is untouched', () => {
      expect(touchEvidenceFromFiles(files(), 'src/other.ts', null)).toEqual({
        touched: false,
        granularity: 'file',
      });
    });
  });

  it('an empty completed walk is untouched, not undecidable', () => {
    // `[]` is a real answer — the compare ran and nothing changed.
    expect(touchEvidenceFromFiles([], 'src/a.ts', 11)).toEqual({
      touched: false,
      granularity: 'line',
    });
  });
});

describe('classifyResolvedThread', () => {
  it('a 👎 on the root comment suppresses, and names who reacted', () => {
    const v = classifyResolvedThread(facts({ thumbsDownBy: 'octocat' }));
    expect(v).toMatchObject({ write: true, outcome: 'not-relevant', method: 'wont-fix', direction: 'suppress' });
    if (v.write) expect(v.reason).toContain('octocat');
  });

  it('a decline reply suppresses', () => {
    const v = classifyResolvedThread(facts({ replies: ['this is by design'] }));
    expect(v).toMatchObject({ write: true, outcome: 'not-relevant', direction: 'suppress' });
  });

  it('unreadable thread state writes nothing', () => {
    expect(classifyResolvedThread(facts({ state: null }))).toMatchObject({
      write: false,
      skip: 'thread-state-unavailable',
    });
  });

  it('an outdated anchor writes nothing — a deletion is not an accepted fix', () => {
    expect(classifyResolvedThread(facts({ state: { isResolved: true, isOutdated: true } }))).toMatchObject({
      write: false,
      skip: 'anchor-gone',
    });
  });

  it('a live anchor with nothing declining it amplifies', () => {
    expect(classifyResolvedThread(facts())).toMatchObject({
      write: true,
      outcome: 'relevant',
      method: 'fixed',
      direction: 'amplify',
    });
  });

  it('the authors own words outrank the anchor state', () => {
    // A declined thread that is ALSO outdated is still a decline: the reply is
    // direct evidence, the anchor is an inference about missing evidence.
    const v = classifyResolvedThread(
      facts({ replies: ["won't fix"], state: { isResolved: true, isOutdated: true } }),
    );
    expect(v).toMatchObject({ write: true, direction: 'suppress' });
  });

  it('ignores touch evidence entirely — both branches ended at the same verdict', () => {
    const untouched = classifyResolvedThread(facts({ touch: { touched: false, granularity: 'line' } }));
    const touched = classifyResolvedThread(facts({ touch: { touched: true, granularity: 'line' } }));
    const unwalked = classifyResolvedThread(facts({ touch: null }));
    expect(untouched).toEqual(touched);
    expect(untouched).toEqual(unwalked);
  });

  it('always returns a discriminated union — never undefined', () => {
    expect(classifyResolvedThread(facts())).toBeDefined();
    expect(classifyResolvedThread(facts({ state: null, path: null, line: null }))).toBeDefined();
  });
});

describe('classifyMergedThread', () => {
  it('unreadable thread state writes nothing', () => {
    expect(classifyMergedThread(facts({ state: null }))).toMatchObject({
      write: false,
      skip: 'thread-state-unknown',
    });
  });

  it('a RESOLVED thread is left to the resolved-thread path — no double write', () => {
    expect(classifyMergedThread(facts({ state: { isResolved: true, isOutdated: false } }))).toMatchObject({
      write: false,
      skip: 'already-classified-on-resolve',
    });
  });

  it('the resolved skip outranks every write branch below it', () => {
    // Otherwise a resolved-and-declined thread is recorded twice: once by the
    // resolve trigger and once here.
    const v = classifyMergedThread(
      facts({ state: { isResolved: true, isOutdated: false }, replies: ['by design'], thumbsDownBy: 'octocat' }),
    );
    expect(v.write).toBe(false);
  });

  it('a decline reply on an open thread suppresses as wont-fix, not as neglect', () => {
    expect(classifyMergedThread(facts({ replies: ['out of scope'] }))).toMatchObject({
      write: true,
      outcome: 'not-relevant',
      method: 'wont-fix',
    });
  });

  it('a 👎 with no reply is a decline, not ignored-at-merge', () => {
    expect(classifyMergedThread(facts({ thumbsDownBy: 'octocat' }))).toMatchObject({
      write: true,
      outcome: 'not-relevant',
      method: 'wont-fix',
    });
  });

  it('an outdated anchor writes nothing', () => {
    expect(classifyMergedThread(facts({ state: { isResolved: false, isOutdated: true } }))).toMatchObject({
      write: false,
      skip: 'anchor-gone',
    });
  });

  it('a comment with no path writes nothing', () => {
    expect(classifyMergedThread(facts({ path: null }))).toMatchObject({ write: false, skip: 'no-anchor' });
  });

  it('an INCOMPLETE commit walk writes nothing — it is not "untouched"', () => {
    expect(classifyMergedThread(facts({ touch: null }))).toMatchObject({
      write: false,
      skip: 'touch-undecidable',
    });
  });

  it('a touched region writes nothing — unknown, not ignored', () => {
    expect(classifyMergedThread(facts({ touch: { touched: true, granularity: 'line' } }))).toMatchObject({
      write: false,
      skip: 'region-edited',
    });
  });

  it('a touched FILE (no line anchor) writes nothing and says why', () => {
    const v = classifyMergedThread(facts({ line: null, touch: { touched: true, granularity: 'file' } }));
    expect(v).toMatchObject({ write: false, skip: 'region-edited' });
    if (!v.write) expect(v.reason).toContain('no line anchor');
  });

  it('open at merge, undeclined, live anchor, untouched → weak suppression', () => {
    expect(classifyMergedThread(facts())).toMatchObject({
      write: true,
      outcome: 'weak-not-relevant',
      method: 'ignored-at-merge',
      direction: 'suppress',
    });
  });

  it('a file-level comment on an untouched file still records, with the file caveat', () => {
    const v = classifyMergedThread(facts({ line: null, touch: { touched: false, granularity: 'file' } }));
    expect(v).toMatchObject({ write: true, method: 'ignored-at-merge' });
    if (v.write) expect(v.reason).toContain('file untouched');
  });

  it('ignored-at-merge is WEAK, never the same strength as an explicit decline', () => {
    const neglected = classifyMergedThread(facts());
    const declined = classifyMergedThread(facts({ replies: ['by design'] }));
    expect(neglected.write && neglected.outcome).toBe('weak-not-relevant');
    expect(declined.write && declined.outcome).toBe('not-relevant');
  });
});

describe('buildRelevanceRecord', () => {
  const verdict: RelevanceRecordVerdict = {
    write: true,
    outcome: 'relevant',
    method: 'fixed',
    direction: 'amplify',
    reason: 'Thread resolved',
  };
  const NOW = '2026-01-01T00:00:00.000Z';

  function record(overrides: Record<string, unknown> = {}) {
    return buildRelevanceRecord({
      verdict,
      markerValue: 'correctness:null-deref:handle@src/a.ts',
      agentName: 'pr-reviewer',
      commentAuthor: 'review-bot',
      commentAuthorIsBot: true,
      pr: 7,
      repo: 'mthines/lorekit',
      commentId: 12345,
      now: NOW,
      ttlDays: 60,
      ...overrides,
    } as Parameters<typeof buildRelevanceRecord>[0]);
  }

  it('copies the marker value verbatim into fingerprint', () => {
    expect(record().fingerprint).toBe('correctness:null-deref:handle@src/a.ts');
  });

  it('carries the verdict through unchanged', () => {
    expect(record()).toMatchObject({
      relevance: 'relevant',
      direction: 'amplify',
      resolution_method: 'fixed',
      reason: 'Thread resolved',
    });
  });

  it('attributes the finding to the agent name the installation declared', () => {
    expect(record().source).toEqual({ login: 'review-bot', type: 'bot', agent: 'pr-reviewer' });
  });

  it('marks a human-authored comment as human', () => {
    expect((record({ commentAuthorIsBot: false }).source as { type: string }).type).toBe('human');
  });

  it('names the writer so the two producers are distinguishable in the data', () => {
    expect(record().writer).toBe('github-app');
  });

  it('always writes status candidate — the lifecycle is recomputed at read time', () => {
    expect(record().status).toBe('candidate');
    expect(record().seen_count).toBe(1);
  });

  it('carries exactly one evidence entry, keyed to this PR', () => {
    expect(record().evidence).toEqual([{ pr: 7, signal: 'fixed', at: NOW, by: 'review-bot' }]);
  });

  it('records an example that links repo, PR, and comment', () => {
    expect(record().examples).toEqual(['mthines/lorekit#7 comment 12345']);
  });

  it('omits the comment id from the example when there is none', () => {
    expect(record({ commentId: null }).examples).toEqual(['mthines/lorekit#7']);
  });

  it('derives expires from the injected clock, not Date.now', () => {
    expect(record({ ttlDays: 1 }).expires).toBe('2026-01-02T00:00:00.000Z');
    expect(record({ ttlDays: 60 }).expires).toBe('2026-03-02T00:00:00.000Z');
  });

  it('carries no severity field — grading needs vocabulary this module does not have', () => {
    expect('severity' in record()).toBe(false);
  });

  it('is JSON-serialisable', () => {
    expect(() => JSON.stringify(record())).not.toThrow();
  });
});
