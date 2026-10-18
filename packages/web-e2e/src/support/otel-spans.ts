/**
 * Playwright results → OTLP/JSON spans, for `otel-reporter.ts` to ship.
 *
 * Pure: no I/O, no clock, ids injected — so `otel-spans.test.ts` can pin the
 * shape. The span model is ported from dash0's `tests/e2e` reporter:
 *
 *   • one ROOT span per test attempt, each its own trace. A run of 70 tests is
 *     70 small traces you can filter, not one trace nobody can read. A retried
 *     test emits one root per attempt, so a flake shows up as two traces.
 *   • a child span per step — `test.step`, Playwright actions, `expect`s and
 *     hooks. Fixture setup is plumbing: its spans are dropped and their children
 *     re-parented to the nearest kept ancestor.
 *
 * What it deliberately does NOT carry, unlike the dash0 original: stdout,
 * stderr, attachment paths, username and hostname — and it rewrites the absolute
 * paths in error messages and stacks (which name the home directory) as
 * relative ones. And it REDACTS every typed value — Playwright titles
 * `locator.fill(x)` as `Fill "x"`, and a failed action's error carries a call
 * log with `fill("x")` in it, so the test account's password would otherwise
 * ride a span name or an exception into Dash0. Known secret values are blanked
 * from error text on top of that, whatever shape they arrive in.
 */

/**
 * The repo's ONE OTLP/JSON encoder — scripts/telemetry/otlp-export.mjs, shared
 * with the sweep/load/eval exporters (int64 as a string, nanosecond strings) —
 * passed in rather than imported: Playwright compiles this file to CommonJS,
 * which cannot statically import an ES module, so the reporter loads it with
 * `import()` and hands it over.
 */
export interface OtlpEncoder {
  toOtlpAttributes(attrs: Record<string, string | number | boolean | undefined>): OtlpAttribute[];
  toUnixNano(ms: number): string;
}
/** `{key, value: AnyValue}` — AnyValue being e.g. `{ stringValue }` or `{ intValue }`. */
export interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

/** OTLP span kind INTERNAL: a test acts for nobody. */
const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

/** Step categories that become spans. The rest (`fixture`, `attach`, …) are folded away. */
const KEPT_STEP_CATEGORIES = new Set(['test.step', 'pw:api', 'expect', 'hook']);
/** A runaway loop of actions must not become a 10k-span trace. */
export const MAX_STEP_SPANS = 250;

const NAME_MAX = 200;
const MESSAGE_MAX = 1024;
const STACK_MAX = 4096;

/** Playwright API titles that interpolate what the test TYPED (protocolMetainfo.js). */
const TYPING_STEP = /^(Fill|Type|Insert|Press|Key up|Key down) "/;
/**
 * The same typed values inside error text: a call-log title (`Fill "x"`) or a
 * call-log action (`fill("x")`, `elementHandle.type("x")`). Playwright does not
 * escape the value, so match greedily to the line's last quote.
 */
const TYPED_IN_ERROR = [
  /\b(Fill|Type|Insert|Press|Key up|Key down) ".*"/g,
  /\b(fill|type|press|insertText)\(".*"\)/g,
] as const;

export interface StepLike {
  title: string;
  category: string;
  startTime: Date;
  duration: number;
  error?: { message?: string };
  steps: StepLike[];
}

export interface TestLike {
  /** describe blocks + title, without the root/project/file entries. */
  titlePath: string[];
  projectName: string;
  /** Repo-relative path, e.g. `packages/web-e2e/src/journeys/login.e2e.ts`. */
  file: string;
  line: number;
  tags: string[];
  expectedStatus: string;
  /** The `test.skip(cond, reason)` reason, when there was one. */
  skipReason?: string;
}

export interface ResultLike {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  startTime: Date;
  duration: number;
  retry: number;
  workerIndex: number;
  error?: { message?: string; stack?: string };
  steps: StepLike[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events?: { name: string; timeUnixNano: string; attributes: OtlpAttribute[] }[];
  status: { code: number; message?: string };
}

/** `bytes` random bytes as lowercase hex — 16 for a trace id, 8 for a span id. */
export type NewId = (bytes: 8 | 16) => string;

/**
 * `[literal, replacement]` pairs applied to error text, in order — known secret
 * values → `…`, then the repo root → `''`, then the home directory → `~`. A
 * stack frame `/Users/<name>/…` would otherwise ship the username.
 */
export type Redactions = readonly (readonly [string, string])[];

/** Env vars whose values must never appear in exported error text. */
export const SECRET_ENV = ['E2E_USER_PASSWORD', 'LOREKIT_TESTING_USER_PW', 'E2E_SUPABASE_SERVICE_ROLE_KEY'] as const;

/** Secret values blanked first, then repo-relative paths, then `~` for the rest of home. */
export function buildRedactions(env: Record<string, string | undefined>, repoRoot: string, home: string): Redactions {
  const secrets = SECRET_ENV.map((name) => env[name]?.trim()).filter((v): v is string => !!v);
  return [...secrets.map((secret) => [secret, '…'] as const), [`${repoRoot.replace(/\/+$/, '')}/`, ''], [home, '~']];
}

function redact(text: string | undefined, redactions: Redactions): string | undefined {
  if (!text) return text;
  const literal = redactions.reduce((out, [from, to]) => (from ? out.split(from).join(to) : out), text);
  return TYPED_IN_ERROR.reduce(
    (out, pattern) => out.replace(pattern, (match) => match.replace(/(\(?)".*"(\)?)$/, '$1"…"$2')),
    literal,
  );
}

// eslint-disable-next-line no-control-regex -- matching the ESC control character is the point
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

function clean(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const plain = text.replace(ANSI, '');
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** A step's span name, with any typed value replaced. */
export function stepSpanName(category: string, title: string): string {
  if (category === 'pw:api') {
    const typing = TYPING_STEP.exec(title);
    if (typing) return `${typing[1]} "…"`;
  }
  return clean(title, NAME_MAX) ?? category;
}

/** Did the attempt end the way the test said it would (`test.fail()` included)? */
function outcome(test: TestLike, result: ResultLike): 'pass' | 'fail' | 'skipped' {
  if (result.status === 'skipped') return 'skipped';
  return result.status === test.expectedStatus ? 'pass' : 'fail';
}

/** The spans for one test attempt: its root first, then its steps in start order. */
export function buildTestSpans(
  test: TestLike,
  result: ResultLike,
  newId: NewId,
  { toOtlpAttributes, toUnixNano }: OtlpEncoder,
  redactions: Redactions = [],
): OtlpSpan[] {
  const errorText = (text: string | undefined, max: number) => clean(redact(text, redactions), max);
  const traceId = newId(16);
  const rootId = newId(8);
  const startMs = result.startTime.getTime();
  const verdict = outcome(test, result);
  const failed = verdict === 'fail';

  const stepSpans: OtlpSpan[] = [];
  let droppedSteps = 0;
  const walk = (steps: StepLike[], parentSpanId: string) => {
    for (const step of steps) {
      if (!KEPT_STEP_CATEGORIES.has(step.category)) {
        walk(step.steps, parentSpanId);
        continue;
      }
      if (stepSpans.length >= MAX_STEP_SPANS) {
        droppedSteps += 1 + countKept(step.steps);
        continue;
      }
      const spanId = newId(8);
      const stepStart = step.startTime.getTime();
      const message = errorText(step.error?.message, MESSAGE_MAX);
      stepSpans.push({
        traceId,
        spanId,
        parentSpanId,
        name: stepSpanName(step.category, step.title),
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: toUnixNano(stepStart),
        endTimeUnixNano: toUnixNano(stepStart + step.duration),
        attributes: toOtlpAttributes({ 'lorekit.e2e.step.category': step.category }),
        status: step.error ? { code: STATUS_ERROR, message } : { code: STATUS_UNSET },
      });
      walk(step.steps, spanId);
    }
  };
  walk(result.steps, rootId);

  const endMs = startMs + result.duration;
  const message = failed ? (errorText(result.error?.message, MESSAGE_MAX) ?? `test ${result.status}`) : undefined;
  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: clean(test.titlePath.join(' › '), NAME_MAX) ?? 'test',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(startMs),
    endTimeUnixNano: toUnixNano(endMs),
    attributes: toOtlpAttributes({
      // OTel semantic conventions (test.*) first, then this suite's own.
      'test.case.name': [test.file, ...test.titlePath].join(' › '),
      'test.case.result.status': verdict === 'skipped' ? undefined : verdict,
      'test.suite.name': test.file,
      'lorekit.e2e.project': test.projectName,
      'lorekit.e2e.status': result.status,
      'lorekit.e2e.expected_status': test.expectedStatus,
      'lorekit.e2e.retry': result.retry,
      'lorekit.e2e.flaky': verdict === 'pass' && result.retry > 0,
      'lorekit.e2e.worker_index': result.workerIndex,
      'lorekit.e2e.duration_ms': result.duration,
      'lorekit.e2e.tags': test.tags.length ? test.tags.join(',') : undefined,
      'lorekit.e2e.skip_reason': verdict === 'skipped' ? test.skipReason : undefined,
      'lorekit.e2e.steps_dropped': droppedSteps || undefined,
      'code.file.path': test.file,
      'code.line.number': test.line,
    }),
    status: failed ? { code: STATUS_ERROR, message } : { code: STATUS_UNSET },
  };
  if (failed && result.error) {
    root.events = [
      {
        name: 'exception',
        timeUnixNano: toUnixNano(endMs),
        attributes: toOtlpAttributes({
          'exception.type': `playwright.${result.status}`,
          'exception.message': message,
          'exception.stacktrace': errorText(result.error.stack, STACK_MAX),
        }),
      },
    ];
  }
  return [root, ...stepSpans];
}

function countKept(steps: StepLike[]): number {
  return steps.reduce((n, s) => n + (KEPT_STEP_CATEGORIES.has(s.category) ? 1 : 0) + countKept(s.steps), 0);
}
