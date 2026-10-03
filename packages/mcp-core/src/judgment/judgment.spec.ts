import { describe, it, expect } from 'vitest';
import {
  resolveJudgmentConfig,
  isJudgmentEligible,
  buildJudgmentRequest,
  parseJudgmentResponse,
  classifyHttpStatus,
  classifyThrown,
  withJudgedRelevance,
  JUDGMENT_OUTCOMES,
  JUDGMENT_TOP_N,
  UNJUDGED_RELEVANCE,
  type JudgedLessonInput,
} from './judgment.js';
import { rankLessons, selectDiverse, type RankableLesson } from '../ranking/lesson-rank.js';

/**
 * Unit coverage for the judgment pure module. `judgment-parity.spec.ts`
 * separately holds this file's behaviour to the CLI's `judgment-pure.mjs`
 * twin — these specs pin the RULES against `lesson-rank.ts`'s real
 * `rankLessons`/`selectDiverse`, i.e. exactly the composition D8 describes for
 * `handlers/relevant.ts`.
 */

const NOW = Date.parse('2026-09-23T00:00:00.000Z');

type Candidate = RankableLesson & { ref: string; key: string; value: string; org_id?: string | null };

/** The D8 composition, reproduced at the unit-test boundary: this is exactly
 *  what `relevant.ts` is specified to do with `withJudgedRelevance`'s output —
 *  a second `rankLessons` pass over the FULL population, then `selectDiverse`. */
function composeRelevantOrder(candidates: Candidate[], judged: Map<string, number> | null, limit: number) {
  const withRelevance = withJudgedRelevance(candidates, judged, (c) => c.ref);
  const ranked = rankLessons(withRelevance, { now: NOW });
  return selectDiverse(ranked, limit).map((r) => (r.entry as Candidate).key);
}

describe('AC-10: judged relevance can overturn the baseline order', () => {
  it('ranks a low-baseline, highly-judged lesson above a high-baseline, unrelated one', () => {
    // Both rows match the FTS predicate, so BOTH start at the binary
    // pre-judgment relevance of 1 (`matched ? 1 : 0`, D8 step 1) — A edges
    // ahead of B on recency alone (same seen_count, so salience ties; neither
    // sets outcome, so both take the identical cold-start prior). TypeSafe
    // then scores A=0/2 (unrelated) and B=2/2 (directly applies): A's
    // relevance factor drops to 0 while B's stays at 1, which is more than
    // enough to overturn A's small recency edge — the exact fixture AC-10
    // describes.
    const candidates: Candidate[] = [
      { ref: 'g:a', key: 'a', value: 'A', updated_at: new Date(NOW).toISOString(), seen_count: 5, relevance: 1 },
      { ref: 'g:b', key: 'b', value: 'B', updated_at: new Date(NOW - 3 * 86400000).toISOString(), seen_count: 5, relevance: 1 },
    ];
    const baselineOrder = selectDiverse(rankLessons(candidates, { now: NOW }), 2).map((r) => r.entry.key);
    expect(baselineOrder[0]).toBe('a');

    const judged = new Map([
      ['g:a', 0], // score 0 → 0/2
      ['g:b', 1], // score 2 → 2/2
    ]);
    const judgedOrder = composeRelevantOrder(candidates, judged, 2);
    expect(judgedOrder[0]).toBe('b');
  });

  it('score/2 is the normalisation the fixture relies on', () => {
    const lessons: JudgedLessonInput[] = [{ ref: 'g:a', key: 'a', value: 'v' }];
    const parsed = parseJudgmentResponse({ answers: { c0: { type: 'score', score: 2 } } }, lessons);
    expect(parsed.ok && parsed.relevance.get('g:a')).toBe(1);
    const parsedZero = parseJudgmentResponse({ answers: { c0: { type: 'score', score: 0 } } }, lessons);
    expect(parsedZero.ok && parsedZero.relevance.get('g:a')).toBe(0);
    const parsedMid = parseJudgmentResponse({ answers: { c0: { type: 'score', score: 1 } } }, lessons);
    expect(parsedMid.ok && parsedMid.relevance.get('g:a')).toBe(0.5);
  });

  it('requests carry at most JUDGMENT_TOP_N score questions', () => {
    const lessons: JudgedLessonInput[] = Array.from({ length: 60 }, (_, i) => ({ ref: `r${i}`, key: `k${i}`, value: 'v' }));
    const { questionIds, body } = buildJudgmentRequest('situation', lessons);
    expect(questionIds.length).toBe(JUDGMENT_TOP_N);
    expect(Object.keys(body.questions as object).length).toBe(JUDGMENT_TOP_N);
  });
});

describe('AC-12: every non-applied outcome reproduces the exact baseline', () => {
  const candidates: Candidate[] = [
    { ref: 'g:a', key: 'a', value: 'A', updated_at: new Date(NOW).toISOString(), seen_count: 3, relevance: 1 },
    { ref: 'g:b', key: 'b', value: 'B', updated_at: new Date(NOW - 5 * 86400000).toISOString(), seen_count: 1, relevance: 1 },
    { ref: 'g:c', key: 'c', value: 'C', updated_at: new Date(NOW - 40 * 86400000).toISOString(), seen_count: 9, relevance: 1 },
  ];

  const nonAppliedOutcomes = Object.keys(JUDGMENT_OUTCOMES).filter((o) => o !== 'applied');

  it.each(nonAppliedOutcomes)('outcome=%s: withJudgedRelevance(c, null, …) is the identical array', (outcome) => {
    // Every non-applied outcome maps to `judged: null` at the call site (only
    // `applied` ever produces a Map) — this is the contract the handler enforces.
    expect(JUDGMENT_OUTCOMES[outcome as keyof typeof JUDGMENT_OUTCOMES].called).toBeDefined();
    const result = withJudgedRelevance(candidates, null, (c) => c.ref);
    expect(result).toBe(candidates);
  });

  it('the composed order under judged=null equals the plain baseline selectDiverse(filtered, limit)', () => {
    const baseline = selectDiverse(rankLessons(candidates, { now: NOW }), 3).map((r) => r.entry.key);
    const composed = composeRelevantOrder(candidates, null, 3);
    expect(composed).toEqual(baseline);
  });
});

describe('AC-27: org-owned candidates are excluded from judgment', () => {
  const personal: Candidate = { ref: 'g:personal', key: 'personal', value: 'mine', org_id: null };
  const orgOwned: Candidate = { ref: 'g:org', key: 'org', value: 'theirs', org_id: 'org_1' };

  it('isJudgmentEligible rejects an org-owned row', () => {
    expect(isJudgmentEligible(personal)).toBe(true);
    expect(isJudgmentEligible(orgOwned)).toBe(false);
  });

  it('an org-owned row never appears in buildJudgmentRequest output when the caller filters first', () => {
    const eligible = [personal, orgOwned].filter(isJudgmentEligible);
    const { body } = buildJudgmentRequest('situation', eligible);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('theirs');
    expect(serialized).not.toContain('"org"');
  });

  it('an org-owned row receives UNJUDGED_RELEVANCE even when personal rows are judged', () => {
    const judged = new Map([['g:personal', 0.9]]);
    const result = withJudgedRelevance([personal, orgOwned], judged, (c) => c.ref);
    expect(result.find((c) => c.ref === 'g:personal')?.relevance).toBe(0.9);
    expect(result.find((c) => c.ref === 'g:org')?.relevance).toBe(UNJUDGED_RELEVANCE);
  });
});

describe('resolveJudgmentConfig', () => {
  it('disabled beats a present key', () => {
    expect(resolveJudgmentConfig({ apiKey: 'k', env: { LOREKIT_JUDGMENT_DISABLED: 'true' } })).toEqual({
      enabled: false,
      reason: 'skipped_disabled',
    });
  });
  it('no key, not disabled', () => {
    expect(resolveJudgmentConfig({ apiKey: '' })).toEqual({ enabled: false, reason: 'skipped_no_key' });
  });
  it('enabled with a trimmed key', () => {
    expect(resolveJudgmentConfig({ apiKey: '  ts_key  ' })).toEqual({ enabled: true, apiKey: 'ts_key' });
  });
});

describe('classification', () => {
  it('classifyHttpStatus', () => {
    expect(classifyHttpStatus(401)).toBe('rejected');
    expect(classifyHttpStatus(403)).toBe('rejected');
    expect(classifyHttpStatus(429)).toBe('rate_limited');
    expect(classifyHttpStatus(529)).toBe('rate_limited');
    expect(classifyHttpStatus(422)).toBe('error');
    expect(classifyHttpStatus(500)).toBe('error');
  });
  it('classifyThrown', () => {
    expect(classifyThrown(Object.assign(new Error(), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyThrown(Object.assign(new Error(), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyThrown(new TypeError('x'))).toBe('error');
    expect(classifyThrown('nope')).toBe('error');
  });
});

describe('parseJudgmentResponse: all-or-nothing malformed handling', () => {
  const lessons: JudgedLessonInput[] = [
    { ref: 'a', key: 'a', value: 'v' },
    { ref: 'b', key: 'b', value: 'v' },
  ];
  it('missing a shortlisted id fails the whole response', () => {
    const res = parseJudgmentResponse({ answers: { c0: { type: 'score', score: 1 } } }, lessons);
    expect(res.ok).toBe(false);
  });
  it('wrong type fails', () => {
    const res = parseJudgmentResponse(
      { answers: { c0: { type: 'score', score: 1 }, c1: { type: 'choice', score: 1 } } },
      lessons,
    );
    expect(res.ok).toBe(false);
  });
  it('non-finite score fails', () => {
    const res = parseJudgmentResponse(
      { answers: { c0: { type: 'score', score: 1 }, c1: { type: 'score', score: Infinity } } },
      lessons,
    );
    expect(res.ok).toBe(false);
  });
  it('non-object body fails', () => {
    expect(parseJudgmentResponse(null, lessons).ok).toBe(false);
    expect(parseJudgmentResponse('nope', lessons).ok).toBe(false);
  });
});
