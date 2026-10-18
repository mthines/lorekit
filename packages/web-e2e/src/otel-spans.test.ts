import { beforeAll, describe, expect, it } from 'vitest';
import { loadOtlpExport, loadTelemetryConfig } from './support/otel-modules';
import { buildRedactions, buildTestSpans, type OtlpEncoder, MAX_STEP_SPANS, stepSpanName, type ResultLike, type StepLike, type TestLike } from './support/otel-spans';

const T0 = new Date('2026-10-18T12:00:00.000Z');

const test: TestLike = {
  titlePath: ['the signed-in app shell', 'keeps the session across a reload'],
  projectName: 'signed-in',
  file: 'journeys/dashboard.e2e.ts',
  line: 13,
  tags: ['@signed-in'],
  expectedStatus: 'passed',
};

const step = (title: string, category: string, steps: StepLike[] = [], error?: string): StepLike => ({
  title,
  category,
  startTime: T0,
  duration: 10,
  steps,
  ...(error ? { error: { message: error } } : {}),
});

const result = (over: Partial<ResultLike> = {}): ResultLike => ({
  status: 'passed',
  startTime: T0,
  duration: 1500,
  retry: 0,
  workerIndex: 1,
  steps: [],
  ...over,
});

let encoder: OtlpEncoder;
beforeAll(async () => {
  encoder = await loadOtlpExport();
});

let counter = 0;
const newId = (bytes: 8 | 16) => String(++counter).padStart(bytes * 2, '0');
const build = (r: ResultLike, t: TestLike = test) => buildTestSpans(t, r, newId, encoder);
const attrs = (span: { attributes: { key: string; value: Record<string, unknown> }[] }) =>
  Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

describe('the reused CLI telemetry config', () => {
  // The reporter calls this at runtime only, from onEnd, where a break is just a
  // log line — so pin the contract it relies on here.
  it('resolves an endpoint and headers with a token, and disables on opt-out', async () => {
    const resolveTelemetryConfig = await loadTelemetryConfig();
    const on = resolveTelemetryConfig({ LOREKIT_TELEMETRY_TOKEN: 'test-token' });
    expect(on).toMatchObject({ enabled: true, endpoint: expect.stringMatching(/^https?:\/\//), headers: expect.any(Object) });
    expect(resolveTelemetryConfig({ LOREKIT_TELEMETRY_TOKEN: 'test-token', LOREKIT_TELEMETRY: 'off' })).toMatchObject({
      enabled: false,
      reason: expect.any(String),
    });
  });
});

describe('buildRedactions', () => {
  it('blanks configured secrets first, then makes repo paths relative, then folds home to ~', () => {
    const redactions = buildRedactions(
      { E2E_USER_PASSWORD: ' hunter2 ', LOREKIT_TESTING_USER_PW: '', E2E_SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', OTHER: 'kept' },
      '/home/ci/repo/',
      '/home/ci',
    );
    expect(redactions).toEqual([
      ['hunter2', '…'],
      ['sb_secret_x', '…'],
      ['/home/ci/repo/', ''],
      ['/home/ci', '~'],
    ]);
    const [root] = buildTestSpans(
      test,
      result({ status: 'failed', error: { message: 'hunter2 at /home/ci/repo/packages/a.ts and /home/ci/.cache/b.js' } }),
      newId,
      encoder,
      redactions,
    );
    expect(root.status.message).toBe('… at packages/a.ts and ~/.cache/b.js');
  });
});

describe('stepSpanName', () => {
  it.each([
    ['Fill "hunter2"', 'Fill "…"'],
    ['Type "secret text"', 'Type "…"'],
    ['Insert "x"', 'Insert "…"'],
    ['Press "Enter"', 'Press "…"'],
    ['Key down "Shift"', 'Key down "…"'],
  ])('redacts the typed value of %s', (title, expected) => {
    expect(stepSpanName('pw:api', title)).toBe(expected);
  });

  it('keeps titles that carry no typed value', () => {
    expect(stepSpanName('pw:api', 'Navigate to "/login"')).toBe('Navigate to "/login"');
    expect(stepSpanName('test.step', 'Fill "the form"')).toBe('Fill "the form"');
  });
});

describe('buildTestSpans', () => {
  it('emits one root per attempt, in its own trace, with the test.* conventions', () => {
    const [root, ...rest] = build(result());
    expect(rest).toEqual([]);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).toHaveLength(32);
    expect(root.name).toBe('the signed-in app shell › keeps the session across a reload');
    expect(root.status).toEqual({ code: 0 });
    expect(attrs(root)).toMatchObject({
      'test.case.name': 'journeys/dashboard.e2e.ts › the signed-in app shell › keeps the session across a reload',
      'test.case.result.status': 'pass',
      'lorekit.e2e.project': 'signed-in',
      'lorekit.e2e.retry': '0',
      'lorekit.e2e.flaky': false,
      'lorekit.e2e.tags': '@signed-in',
    });
    expect(root.startTimeUnixNano).toBe(`${T0.getTime()}000000`);
    expect(root.endTimeUnixNano).toBe(`${T0.getTime() + 1500}000000`);
  });

  it('marks an unexpected failure as an ERROR with an exception event', () => {
    const [root] = build(result({ status: 'failed', error: { message: '\u001b[31mexpected 200\u001b[39m', stack: 'at x' } }));
    expect(root.status).toEqual({ code: 2, message: 'expected 200' });
    expect(attrs(root)['test.case.result.status']).toBe('fail');
    const [exception] = root.events ?? [];
    expect(exception.name).toBe('exception');
    expect(attrs(exception)).toMatchObject({ 'exception.message': 'expected 200', 'exception.stacktrace': 'at x' });
  });

  it('rewrites absolute paths in error text so no home directory leaves the machine', () => {
    const stack = 'Error: boom\n    at /Users/someone/repo/packages/web-e2e/journeys/a.e2e.ts:3:1\n    at /Users/someone/.cache/x.js:1:1';
    const [root] = buildTestSpans(test, result({ status: 'failed', error: { message: 'boom in /Users/someone/repo/x.ts', stack } }), newId, encoder, [
      ['/Users/someone/repo/packages/web-e2e/', ''],
      ['/Users/someone', '~'],
    ]);
    expect(JSON.stringify(root)).not.toContain('someone');
    const [exception] = root.events ?? [];
    expect(attrs(exception)['exception.stacktrace']).toContain('at journeys/a.e2e.ts:3:1');
    expect(attrs(exception)['exception.stacktrace']).toContain('at ~/.cache/x.js:1:1');
    expect(root.status.message).toBe('boom in ~/repo/x.ts');
  });

  it('never ships a typed value or a known secret through error text', () => {
    const callLog = [
      'TimeoutError: locator.fill: Timeout 5000ms exceeded.',
      'Call log:',
      '  - Fill "hunter2" with timeout 5000ms',
      '  - waiting for getByLabel(\'Password\')',
      '  -   fill("hunter2")',
      '  - elementHandle.type("pa"ss")',
    ].join('\n');
    const spans = buildTestSpans(
      test,
      result({
        status: 'failed',
        error: { message: callLog, stack: `${callLog}\n    at x (s3cr3t-key)` },
        steps: [step('Fill "hunter2"', 'pw:api', [], callLog)],
      }),
      newId,
      encoder,
      [['s3cr3t-key', '…']],
    );
    const json = JSON.stringify(spans);
    for (const leaked of ['hunter2', 'pa\\"ss', 's3cr3t-key']) expect(json).not.toContain(leaked);
    expect(spans[0].status.message).toContain('Fill "…" with timeout 5000ms');
    expect(spans[0].status.message).toContain('fill("…")');
    expect(spans[0].status.message).toContain("getByLabel('Password')");
  });

  it('treats an expected failure (test.fail) as a pass', () => {
    const [root] = build(result({ status: 'failed' }), { ...test, expectedStatus: 'failed' });
    expect(root.status.code).toBe(0);
    expect(attrs(root)['test.case.result.status']).toBe('pass');
  });

  it('flags a pass on a retry as flaky', () => {
    expect(attrs(build(result({ retry: 1 }))[0])['lorekit.e2e.flaky']).toBe(true);
  });

  it('records a skip without a pass/fail verdict, keeping the reason', () => {
    const [root] = build(result({ status: 'skipped', duration: 0 }), { ...test, expectedStatus: 'skipped', skipReason: 'no test user' });
    expect(attrs(root)['test.case.result.status']).toBeUndefined();
    expect(attrs(root)['lorekit.e2e.skip_reason']).toBe('no test user');
  });

  it('nests steps, folds fixtures away, and never leaks a typed password', () => {
    const spans = build(
      result({
        steps: [
          step('Fixture "page"', 'fixture', [step('Create context', 'pw:api')]),
          step('WHEN the visitor signs in', 'test.step', [
            step('Fill "hunter2"', 'pw:api'),
            step('Expect "toHaveURL"', 'expect', [], 'timed out'),
          ]),
        ],
      }),
    );
    const [root, create, when, fill, expectStep] = spans;
    expect(spans.map((s) => s.name)).toEqual([root.name, 'Create context', 'WHEN the visitor signs in', 'Fill "…"', 'Expect "toHaveURL"']);
    expect(create.parentSpanId).toBe(root.spanId); // re-parented past the fixture
    expect(fill.parentSpanId).toBe(when.spanId);
    expect(expectStep.status).toEqual({ code: 2, message: 'timed out' });
    expect(JSON.stringify(spans)).not.toContain('hunter2');
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
  });

  it(`caps a test at ${MAX_STEP_SPANS} step spans and counts the rest`, () => {
    const steps = Array.from({ length: MAX_STEP_SPANS + 5 }, (_, i) => step(`Click ${i}`, 'pw:api'));
    const [root, ...stepSpans] = build(result({ steps }));
    expect(stepSpans).toHaveLength(MAX_STEP_SPANS);
    expect(attrs(root)['lorekit.e2e.steps_dropped']).toBe('5');
  });
});
