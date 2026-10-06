import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  resolveJudgmentConfig as resolveTs,
  isJudgmentEligible as eligibleTs,
  buildJudgmentRequest as buildTs,
  parseJudgmentResponse as parseTs,
  classifyHttpStatus as classifyHttpTs,
  classifyThrown as classifyThrownTs,
  withJudgedRelevance as withJudgedTs,
  TYPESAFE_ENDPOINT as ENDPOINT_TS,
  TYPESAFE_MODELS_ENDPOINT as MODELS_ENDPOINT_TS,
  TYPESAFE_MODEL as MODEL_TS,
  JUDGMENT_PROVIDER as PROVIDER_TS,
  JUDGMENT_TOP_N as TOP_N_TS,
  JUDGMENT_TIMEOUT_MS as TIMEOUT_TS,
  MAX_LESSON_CHARS as MAX_LESSON_TS,
  MAX_SITUATION_CHARS as MAX_SITUATION_TS,
  UNJUDGED_RELEVANCE as UNJUDGED_TS,
  RELEVANCE_LEVELS as LEVELS_TS,
  JUDGMENT_OUTCOMES as OUTCOMES_TS,
} from './judgment.js';

/**
 * CROSS-LANGUAGE PARITY (AC-7): `judgment.ts` (mirrored verbatim into the edge
 * tree) must agree byte-for-byte in BEHAVIOUR with
 * `packages/cli/src/shared/judgment-pure.mjs`, the CLI failure-hook's twin.
 * The `lesson-rank.ts` ↔ `lessons-pure.mjs` pattern applied to the judgment
 * seam: two languages cannot share one module, so the guard is behavioural
 * rather than a file diff.
 */

const cliModulePath = join(import.meta.dirname, '../../../cli/src/shared/judgment-pure.mjs');
const cli = (await import(/* @vite-ignore */ `file://${cliModulePath}`)) as {
  resolveJudgmentConfig: typeof resolveTs;
  isJudgmentEligible: typeof eligibleTs;
  buildJudgmentRequest: typeof buildTs;
  parseJudgmentResponse: typeof parseTs;
  classifyHttpStatus: typeof classifyHttpTs;
  classifyThrown: typeof classifyThrownTs;
  withJudgedRelevance: typeof withJudgedTs;
  TYPESAFE_ENDPOINT: string;
  TYPESAFE_MODELS_ENDPOINT: string;
  TYPESAFE_MODEL: string;
  JUDGMENT_PROVIDER: string;
  JUDGMENT_TOP_N: number;
  JUDGMENT_TIMEOUT_MS: number;
  MAX_LESSON_CHARS: number;
  MAX_SITUATION_CHARS: number;
  UNJUDGED_RELEVANCE: number;
  RELEVANCE_LEVELS: readonly string[];
  JUDGMENT_OUTCOMES: Record<string, { called: boolean }>;
};

describe('judgment ↔ judgment-pure: every exported constant agrees', () => {
  it('endpoints, model and provider', () => {
    expect(ENDPOINT_TS).toBe(cli.TYPESAFE_ENDPOINT);
    expect(MODELS_ENDPOINT_TS).toBe(cli.TYPESAFE_MODELS_ENDPOINT);
    expect(MODEL_TS).toBe(cli.TYPESAFE_MODEL);
    expect(PROVIDER_TS).toBe(cli.JUDGMENT_PROVIDER);
  });

  it('caps', () => {
    expect(TOP_N_TS).toBe(cli.JUDGMENT_TOP_N);
    expect(TIMEOUT_TS).toBe(cli.JUDGMENT_TIMEOUT_MS);
    expect(MAX_LESSON_TS).toBe(cli.MAX_LESSON_CHARS);
    expect(MAX_SITUATION_TS).toBe(cli.MAX_SITUATION_CHARS);
    expect(UNJUDGED_TS).toBe(cli.UNJUDGED_RELEVANCE);
  });

  it('relevance levels', () => expect([...LEVELS_TS]).toEqual([...cli.RELEVANCE_LEVELS]));
  it('outcome vocabulary', () => expect(OUTCOMES_TS).toEqual(cli.JUDGMENT_OUTCOMES));
});

describe('judgment ↔ judgment-pure: resolveJudgmentConfig agrees', () => {
  const cases: Array<{ apiKey: unknown; env?: Record<string, string | undefined> }> = [
    { apiKey: 'ts_realkeyreal_00000000000000' },
    { apiKey: '  ts_padded_0000000000000000  ' },
    { apiKey: '' },
    { apiKey: null },
    { apiKey: undefined },
    { apiKey: 'ts_key', env: { LOREKIT_JUDGMENT_DISABLED: 'true' } },
    { apiKey: 'ts_key', env: { LOREKIT_JUDGMENT_DISABLED: '1' } },
    { apiKey: 'ts_key', env: { LOREKIT_JUDGMENT_DISABLED: 'no' } },
    { apiKey: 'ts_key', env: {} },
  ];
  it.each(cases)('agrees for %j', (input) => {
    expect(resolveTs(input)).toEqual(cli.resolveJudgmentConfig(input));
  });
});

describe('judgment ↔ judgment-pure: isJudgmentEligible agrees', () => {
  const rows = [{}, { org_id: null }, { org_id: 'org_1' }, { org: 'acme' }, { org: null, org_id: null }];
  it.each(rows)('agrees for %j', (row) => {
    expect(eligibleTs(row)).toBe(cli.isJudgmentEligible(row));
  });
});

const LESSONS = [
  { ref: 'global:one', key: 'one', value: 'Body of lesson one.', trigger: 'timeout' },
  { ref: 'global:two', key: 'two', value: 'Body of lesson two.' },
  { ref: 'repo::a/b:three', key: 'three', value: 'x'.repeat(2000) },
];

describe('judgment ↔ judgment-pure: buildJudgmentRequest agrees', () => {
  it('produces a deep-equal body and question-id list', () => {
    const ts = buildTs('Deploy failed with a timeout.', LESSONS);
    const js = cli.buildJudgmentRequest('Deploy failed with a timeout.', LESSONS);
    expect(ts).toEqual(js);
  });

  it('caps at JUDGMENT_TOP_N on both sides', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ref: `r${i}`, key: `k${i}`, value: 'v' }));
    const ts = buildTs('situation', many);
    const js = cli.buildJudgmentRequest('situation', many);
    expect(ts.questionIds.length).toBe(TOP_N_TS);
    expect(ts).toEqual(js);
  });
});

describe('judgment ↔ judgment-pure: parseJudgmentResponse agrees', () => {
  const validAnswers = {
    model: 'jev-1.13.0',
    usage: { input_tokens: 123 },
    answers: {
      c0: { type: 'score', score: 2, probabilities: [], legend: [], confidence: 0.9 },
      c1: { type: 'score', score: 0 },
      c2: { type: 'score', score: 1.5 },
    },
  };
  const cases: unknown[] = [
    validAnswers,
    null,
    'not an object',
    {},
    { answers: null },
    { answers: {} }, // missing c0
    { answers: { c0: { type: 'score', score: 2 }, c1: { type: 'not-score', score: 0 }, c2: { type: 'score', score: 1 } } },
    { answers: { c0: { type: 'score', score: 2 }, c1: { type: 'score', score: NaN }, c2: { type: 'score', score: 1 } } },
    { answers: { c0: { type: 'score', score: 2 }, c1: { type: 'score', score: '0' }, c2: { type: 'score', score: 1 } } },
  ];

  it.each(cases)('agrees for %j', (json) => {
    const ts = parseTs(json, LESSONS);
    const js = cli.parseJudgmentResponse(json, LESSONS);
    if (ts.ok) {
      expect(js.ok).toBe(true);
      expect([...ts.relevance.entries()]).toEqual([...(js as typeof ts).relevance.entries()]);
      expect(ts.model).toBe((js as typeof ts).model);
      expect(ts.inputTokens).toBe((js as typeof ts).inputTokens);
    } else {
      expect(js).toEqual(ts);
    }
  });
});

describe('judgment ↔ judgment-pure: classification agrees', () => {
  it('classifyHttpStatus over the documented status codes', () => {
    for (const status of [200, 401, 403, 422, 429, 500, 529]) {
      expect(classifyHttpTs(status)).toBe(cli.classifyHttpStatus(status));
    }
  });

  it('classifyThrown over the documented error shapes', () => {
    const errors = [
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      new TypeError('fetch failed'),
      new Error('boom'),
      'not an error object',
    ];
    for (const err of errors) {
      expect(classifyThrownTs(err)).toBe(cli.classifyThrown(err));
    }
  });
});

describe('judgment ↔ judgment-pure: withJudgedRelevance agrees', () => {
  const candidates = [
    { ref: 'a', relevance: 1 },
    { ref: 'b', relevance: 1 },
    { ref: 'c', relevance: 1 },
  ];
  const refOf = (c: { ref: string }) => c.ref;

  it('identity on null judged', () => {
    const ts = withJudgedTs(candidates, null, refOf);
    const js = cli.withJudgedRelevance(candidates, null, refOf);
    expect(ts).toBe(candidates);
    expect(js).toBe(candidates);
  });

  it('agrees on a populated judged map, including the unjudged fallback', () => {
    const judged = new Map([['a', 0.9], ['c', 0.1]]);
    const ts = withJudgedTs(candidates, judged, refOf);
    const js = cli.withJudgedRelevance(candidates, judged, refOf);
    expect(ts).toEqual(js);
    expect(ts.find((c) => c.ref === 'b')?.relevance).toBe(UNJUDGED_TS);
  });
});
