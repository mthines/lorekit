// Tests for the self-contained CLI telemetry: config resolution / opt-out, the
// pure OTLP payload builders (no PII, correct shape), and the traceCommand
// wrapper (records outcome, swallows telemetry failures, never blocks the CLI).
import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {
  resolveTelemetryConfig,
  commandAttributes,
  buildTracePayload,
  buildMetricsPayload,
  exportInvocation,
  traceCommand,
  getActiveTraceparent,
  normalizeOsType,
  normalizeHostArch,
  resolveDeploymentEnvironment,
  resolveTelemetryTokenSource,
  probeTelemetryExport,
  CLI_OUTCOMES,
  CLI_OUTCOME_VALUES,
} from '../src/telemetry.mjs';
import { TELEMETRY_TOKEN } from '../src/telemetry-token.mjs';
import { injectToken } from '../../../scripts/inject-telemetry-token.mjs';

// A base env with the baked-in default endpoint authenticated via explicit
// headers, so tests don't depend on whether DEFAULT_TOKEN is filled in.
const ENABLED_ENV = { OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer test-token' };

// ── config resolution & opt-out ───────────────────────────────────────────────

test('LOREKIT_TELEMETRY off-values disable export', () => {
  for (const v of ['0', 'off', 'false', 'no', 'disable', 'DISABLED']) {
    assert.equal(resolveTelemetryConfig({ ...ENABLED_ENV, LOREKIT_TELEMETRY: v }).enabled, false);
  }
});

test('DO_NOT_TRACK=1 disables export, DO_NOT_TRACK=0 does not', () => {
  assert.equal(resolveTelemetryConfig({ ...ENABLED_ENV, DO_NOT_TRACK: '1' }).enabled, false);
  assert.equal(resolveTelemetryConfig({ ...ENABLED_ENV, DO_NOT_TRACK: '0' }).enabled, true);
});

test('default endpoint without any auth headers stays disabled', () => {
  // No baked-in token filled in + no explicit headers → nothing to authenticate.
  assert.equal(resolveTelemetryConfig({}).enabled, false);
});

test('explicit OTLP endpoint enables export even without headers', () => {
  const cfg = resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com/' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.endpoint, 'https://otel.example.com'); // trailing slash trimmed
});

test('LOREKIT_TELEMETRY_TOKEN sets the bearer against the default endpoint', () => {
  const cfg = resolveTelemetryConfig({ LOREKIT_TELEMETRY_TOKEN: 'auth_env_tok' });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.headers['Authorization'], 'Bearer auth_env_tok');
});

test('OTEL_EXPORTER_OTLP_HEADERS wins over LOREKIT_TELEMETRY_TOKEN', () => {
  const cfg = resolveTelemetryConfig({
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer explicit',
    LOREKIT_TELEMETRY_TOKEN: 'auth_env_tok',
  });
  assert.equal(cfg.headers['Authorization'], 'Bearer explicit');
});

test('OTEL_EXPORTER_OTLP_HEADERS is parsed and Dash0-Dataset applied', () => {
  const cfg = resolveTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc, X-Extra=y',
    DASH0_DATASET: 'my-set',
  });
  assert.equal(cfg.headers['Authorization'], 'Bearer abc');
  assert.equal(cfg.headers['X-Extra'], 'y');
  assert.equal(cfg.headers['Dash0-Dataset'], 'my-set');
});

test('Dash0-Dataset defaults to "default" when DASH0_DATASET is unset', () => {
  const cfg = resolveTelemetryConfig(ENABLED_ENV);
  assert.equal(cfg.headers['Dash0-Dataset'], 'default');
});

test('DASH0_DATASET overrides the "default" fallback', () => {
  const cfg = resolveTelemetryConfig({ ...ENABLED_ENV, DASH0_DATASET: 'staging' });
  assert.equal(cfg.headers['Dash0-Dataset'], 'staging');
});

test('an explicit Dash0-Dataset in OTEL_EXPORTER_OTLP_HEADERS is never clobbered', () => {
  // Regression: the "default" fallback must not overwrite a dataset the caller
  // supplied via OTEL_EXPORTER_OTLP_HEADERS, whether or not DASH0_DATASET is set.
  const viaHeaders = resolveTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc, Dash0-Dataset=custom',
  });
  assert.equal(viaHeaders.headers['Dash0-Dataset'], 'custom');

  const headerWinsOverEnv = resolveTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc, Dash0-Dataset=custom',
    DASH0_DATASET: 'staging',
  });
  assert.equal(headerWinsOverEnv.headers['Dash0-Dataset'], 'custom');
});

test('a differently-cased dash0-dataset header is not duplicated by the default', () => {
  // HTTP header names are case-insensitive, so a lowercase `dash0-dataset` from
  // OTEL_EXPORTER_OTLP_HEADERS must suppress the `default` fallback — otherwise
  // two conflicting dataset headers would be sent.
  const cfg = resolveTelemetryConfig({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer abc, dash0-dataset=custom',
  });
  const datasetKeys = Object.keys(cfg.headers).filter((k) => k.toLowerCase() === 'dash0-dataset');
  assert.deepEqual(datasetKeys, ['dash0-dataset']);
  assert.equal(cfg.headers['dash0-dataset'], 'custom');
});

// ── build-time token injection ─────────────────────────────────────────────────

test('committed TELEMETRY_TOKEN is empty (no secret in git)', () => {
  assert.equal(TELEMETRY_TOKEN, '');
});

test('injectToken rewrites the exported literal with the given token', () => {
  const source = [
    '// comment block',
    "export const TELEMETRY_TOKEN = '';",
    '',
  ].join('\n');
  const out = injectToken(source, 'auth_abc123');
  assert.match(out, /export const TELEMETRY_TOKEN = "auth_abc123";/);
  assert.ok(out.includes('// comment block')); // surrounding content preserved
});

test('injectToken safely escapes the token into a string literal', () => {
  const out = injectToken("export const TELEMETRY_TOKEN = '';", 'a"b\\c');
  // The result must be valid JS — JSON.stringify handles quote/backslash escaping.
  assert.match(out, /export const TELEMETRY_TOKEN = "a\\"b\\\\c";/);
});

test('injectToken returns source unchanged when the export is absent', () => {
  const source = 'export const OTHER = 1;';
  assert.equal(injectToken(source, 'auth_x'), source);
});

// ── attributes: bounded, no PII ────────────────────────────────────────────────

test('commandAttributes carries command/outcome/exit code and only allow-listed flags', () => {
  const attrs = commandAttributes({
    command: 'install',
    args: { global: true, token: 'lk_rw_secret', endpoint: 'https://x', dir: '/home/me/proj', deep: false },
    outcome: 'ok',
    exitCode: 0,
  });
  assert.equal(attrs['lorekit.cli.command'], 'install');
  assert.equal(attrs['lorekit.cli.outcome'], 'ok');
  assert.equal(attrs['lorekit.cli.exit_code'], 0);
  assert.equal(attrs['lorekit.cli.flag.global'], true);
  // false flags are omitted
  assert.equal('lorekit.cli.flag.deep' in attrs, false);
  // no PII leaks through — token / endpoint / dir never become attributes
  const serialized = JSON.stringify(attrs);
  assert.ok(!serialized.includes('lk_rw_secret'));
  assert.ok(!serialized.includes('/home/me/proj'));
  assert.ok(!serialized.includes('https://x'));
});

test('commandAttributes merges extraAttrs into the attribute bag', () => {
  const attrs = commandAttributes({
    command: 'doctor',
    args: {},
    outcome: 'error',
    exitCode: 1,
    extraAttrs: { 'lorekit.cli.doctor.failed_checks': 'connectivity,token' },
  });
  assert.equal(attrs['lorekit.cli.doctor.failed_checks'], 'connectivity,token');
});

// ── resource attributes: OTel-registry os.type / host.arch ────────────────────

test('normalizeOsType maps Node platforms to the OTel os.type vocabulary', () => {
  // The two Node spellings that are NOT valid os.type registry values.
  assert.equal(normalizeOsType('win32'), 'windows');
  assert.equal(normalizeOsType('sunos'), 'solaris');
  // Already-canonical values pass through unchanged.
  for (const v of ['linux', 'darwin', 'freebsd', 'openbsd', 'aix']) {
    assert.equal(normalizeOsType(v), v);
  }
});

test('normalizeHostArch maps Node arches to the OTel host.arch vocabulary', () => {
  assert.equal(normalizeHostArch('x64'), 'amd64');
  assert.equal(normalizeHostArch('ia32'), 'x86');
  assert.equal(normalizeHostArch('arm'), 'arm32');
  // Node reports `ppc` for 32-bit PowerPC; the OTel registry value is `ppc32`.
  assert.equal(normalizeHostArch('ppc'), 'ppc32');
  // Already-canonical / unmapped values pass through unchanged.
  for (const v of ['arm64', 's390x', 'ppc64']) {
    assert.equal(normalizeHostArch(v), v);
  }
});

// ── resource attributes: deployment.environment.name (opt-in override) ────────

test('resolveDeploymentEnvironment is undefined by default (CLI has no ambient env)', () => {
  assert.equal(resolveDeploymentEnvironment({}), undefined);
  // Whitespace-only override is treated as absent.
  assert.equal(resolveDeploymentEnvironment({ DEPLOYMENT_ENVIRONMENT: '   ' }), undefined);
});

test('resolveDeploymentEnvironment reads DEPLOYMENT_ENVIRONMENT then OTEL_DEPLOYMENT_ENVIRONMENT', () => {
  assert.equal(resolveDeploymentEnvironment({ DEPLOYMENT_ENVIRONMENT: 'test' }), 'test');
  assert.equal(resolveDeploymentEnvironment({ OTEL_DEPLOYMENT_ENVIRONMENT: 'staging' }), 'staging');
  // DEPLOYMENT_ENVIRONMENT wins when both are set.
  assert.equal(
    resolveDeploymentEnvironment({ DEPLOYMENT_ENVIRONMENT: 'test', OTEL_DEPLOYMENT_ENVIRONMENT: 'staging' }),
    'test',
  );
});

test('buildTracePayload omits deployment.environment.name unless overridden', () => {
  const prev = process.env.DEPLOYMENT_ENVIRONMENT;
  delete process.env.DEPLOYMENT_ENVIRONMENT;
  try {
    const p = buildTracePayload({ version: '1', name: 'lorekit.cli.list', attributes: {}, startMs: 1, endMs: 2, status: 'ok' });
    const keys = p.resourceSpans[0].resource.attributes.map((a) => a.key);
    assert.ok(!keys.includes('deployment.environment.name'));
  } finally {
    if (prev === undefined) delete process.env.DEPLOYMENT_ENVIRONMENT;
    else process.env.DEPLOYMENT_ENVIRONMENT = prev;
  }
});

test('buildTracePayload emits deployment.environment.name=test when overridden (harness path)', () => {
  const prev = process.env.DEPLOYMENT_ENVIRONMENT;
  process.env.DEPLOYMENT_ENVIRONMENT = 'test';
  try {
    const p = buildTracePayload({ version: '1', name: 'lorekit.cli.list', attributes: {}, startMs: 1, endMs: 2, status: 'ok' });
    const resAttrs = Object.fromEntries(
      p.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]),
    );
    assert.equal(resAttrs['deployment.environment.name'], 'test');
  } finally {
    if (prev === undefined) delete process.env.DEPLOYMENT_ENVIRONMENT;
    else process.env.DEPLOYMENT_ENVIRONMENT = prev;
  }
});

test('buildTracePayload emits os.type / host.arch as OTel-registry values', () => {
  const p = buildTracePayload({
    version: '1', name: 'lorekit.cli.list', attributes: {}, startMs: 1, endMs: 2, status: 'ok',
  });
  const resAttrs = Object.fromEntries(
    p.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  // Whatever this test host reports, the emitted value is never a Node-only
  // spelling that the registry doesn't define.
  assert.equal(resAttrs['os.type'], normalizeOsType(process.platform));
  assert.equal(resAttrs['host.arch'], normalizeHostArch(process.arch));
  assert.ok(!['win32', 'sunos'].includes(resAttrs['os.type']));
  assert.ok(!['x64', 'ia32', 'arm'].includes(resAttrs['host.arch']));
});

// ── payload shape ──────────────────────────────────────────────────────────────

test('buildTracePayload produces a valid single-span OTLP structure', () => {
  const p = buildTracePayload({
    version: '9.9.9',
    name: 'lorekit.cli.doctor',
    attributes: commandAttributes({ command: 'doctor', args: {}, outcome: 'ok', exitCode: 0 }),
    startMs: 1000,
    endMs: 1200,
    status: 'ok',
  });
  const span = p.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'lorekit.cli.doctor');
  assert.equal(span.kind, 1);
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.equal(span.startTimeUnixNano, String(1000 * 1_000_000));
  assert.equal(span.endTimeUnixNano, String(1200 * 1_000_000));
  assert.equal(span.status.code, 1);

  const resAttrs = Object.fromEntries(
    p.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]),
  );
  assert.equal(resAttrs['service.name'], 'cli');
  assert.equal(resAttrs['service.namespace'], 'lorekit');
  assert.equal(resAttrs['service.version'], '9.9.9');
  assert.equal(p.resourceSpans[0].scopeSpans[0].scope.name, 'cli');
});

test('buildTracePayload uses provided traceId and spanId when given', () => {
  const fixedTraceId = 'aabbccddeeff00112233445566778899';
  const fixedSpanId = '0011223344556677';
  const p = buildTracePayload({
    version: '1',
    name: 'lorekit.cli.list',
    attributes: {},
    startMs: 1,
    endMs: 2,
    status: 'ok',
    traceId: fixedTraceId,
    spanId: fixedSpanId,
  });
  const span = p.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.traceId, fixedTraceId);
  assert.equal(span.spanId, fixedSpanId);
});

test('buildTracePayload marks error status with a message', () => {
  const p = buildTracePayload({
    version: '1', name: 'lorekit.cli.migrate', attributes: {}, startMs: 1, endMs: 2,
    status: 'error', statusMessage: 'exit 1',
  });
  const span = p.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.status.code, 2);
  assert.equal(span.status.message, 'exit 1');
});

test('buildMetricsPayload emits a monotonic delta counter of 1', () => {
  const p = buildMetricsPayload({
    version: '1',
    attributes: { 'lorekit.cli.command': 'install' },
    startMs: 1,
    endMs: 2,
  });
  assert.equal(p.resourceMetrics[0].scopeMetrics[0].scope.name, 'cli');
  const metric = p.resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.equal(metric.name, 'lorekit.cli.invocations');
  assert.equal(metric.sum.isMonotonic, true);
  assert.equal(metric.sum.aggregationTemporality, 1);
  assert.equal(metric.sum.dataPoints[0].asInt, '1');
});

// ── export + wrapper behavior (fetch stubbed) ─────────────────────────────────

function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    return { ok: true, status: 200, async text() { return '{}'; } };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('exportInvocation posts to /v1/traces and /v1/metrics with headers', async () => {
  const { calls, restore } = stubFetch();
  try {
    await exportInvocation(
      { enabled: true, endpoint: 'https://otel.example.com', headers: { Authorization: 'Bearer t' } },
      { version: '1', name: 'lorekit.cli.doctor', attributes: {}, startMs: 1, endMs: 2, status: 'ok' },
    );
  } finally {
    restore();
  }
  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, ['https://otel.example.com/v1/metrics', 'https://otel.example.com/v1/traces']);
  assert.equal(calls[0].headers.Authorization, 'Bearer t');
});

test('exportInvocation is a no-op when disabled', async () => {
  const { calls, restore } = stubFetch();
  try {
    await exportInvocation({ enabled: false }, { version: '1', name: 'x', attributes: {}, startMs: 1, endMs: 2, status: 'ok' });
  } finally {
    restore();
  }
  assert.equal(calls.length, 0);
});

test('traceCommand returns the handler exit code and exports a span', async () => {
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const { calls, restore } = stubFetch();
  try {
    const code = await traceCommand('doctor', { deep: true }, '1.0.0', async () => 0);
    assert.equal(code, 0);
    const trace = calls.find((c) => c.url.endsWith('/v1/traces'));
    const span = trace.body.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
    assert.equal(attrs['lorekit.cli.command'].stringValue, 'doctor');
    assert.equal(attrs['lorekit.cli.outcome'].stringValue, 'ok');
    assert.equal(attrs['lorekit.cli.flag.deep'].boolValue, true);
  } finally {
    restore();
    if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
  }
});

test('traceCommand uses stable traceId/spanId: same IDs in the exported span and traceparent', async () => {
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const { calls, restore } = stubFetch();
  let capturedTraceparent = null;
  try {
    await traceCommand('list', {}, '1.0.0', async () => {
      capturedTraceparent = getActiveTraceparent();
      return 0;
    });
    const trace = calls.find((c) => c.url.endsWith('/v1/traces'));
    const span = trace.body.resourceSpans[0].scopeSpans[0].spans[0];
    // The traceparent captured during run() must match the span's traceId/spanId.
    assert.ok(capturedTraceparent, 'traceparent should be set during run()');
    assert.ok(capturedTraceparent.startsWith('00-'), 'traceparent has W3C prefix');
    const [, traceId, spanId] = capturedTraceparent.split('-');
    assert.equal(span.traceId, traceId);
    assert.equal(span.spanId, spanId);
  } finally {
    restore();
    if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
  }
});

test('getActiveTraceparent returns null outside of traceCommand', () => {
  assert.equal(getActiveTraceparent(), null);
});

// ── context propagation is decoupled from export ──────────────────────────────
// Regression: the trace ids used to be generated AFTER the `!config.enabled`
// early return, so every user without an OTLP endpoint (the default — the
// telemetry token is empty in git) sent no traceparent at all and every
// server-side trace was uncorrelated. Context must always exist; only the
// sampled bit reflects whether the CLI span is exported.

test('traceCommand still provides a traceparent when telemetry is disabled (flags 00)', async () => {
  const prev = process.env.LOREKIT_TELEMETRY;
  process.env.LOREKIT_TELEMETRY = 'off';
  const { calls, restore } = stubFetch();
  let captured = null;
  try {
    const code = await traceCommand('list', {}, '1.0.0', async () => {
      captured = getActiveTraceparent();
      return 0;
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 0, 'disabled telemetry must still export nothing');
    assert.ok(captured, 'traceparent must exist even with telemetry disabled');
    assert.ok(captured.startsWith('00-'), 'traceparent has the W3C version prefix');
    assert.ok(captured.endsWith('-00'), 'not-exported → sampled bit clear');
  } finally {
    restore();
    if (prev === undefined) delete process.env.LOREKIT_TELEMETRY;
    else process.env.LOREKIT_TELEMETRY = prev;
  }
  assert.equal(getActiveTraceparent(), null, 'context is cleared after the run');
});

test('traceCommand marks the traceparent sampled (flags 01) when telemetry is enabled', async () => {
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const { restore } = stubFetch();
  let captured = null;
  try {
    await traceCommand('list', {}, '1.0.0', async () => {
      captured = getActiveTraceparent();
      return 0;
    });
    assert.ok(captured, 'traceparent must exist when telemetry is enabled');
    assert.ok(captured.endsWith('-01'), 'exported → sampled bit set');
  } finally {
    restore();
    if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
  }
});

test('the traceparent trace id is a real 32-hex id and stays stable for the whole run, enabled or not', async () => {
  const seen = {};
  for (const mode of ['disabled', 'enabled']) {
    const prevOptOut = process.env.LOREKIT_TELEMETRY;
    const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    if (mode === 'disabled') process.env.LOREKIT_TELEMETRY = 'off';
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
    const { calls, restore } = stubFetch();
    try {
      let first = null;
      let second = null;
      await traceCommand('list', {}, '1.0.0', async () => {
        first = getActiveTraceparent();
        second = getActiveTraceparent();
        return 0;
      });
      // Two reads inside one run must yield the identical header — every
      // outgoing call in that command joins the SAME trace.
      assert.equal(first, second);
      const [version, traceId, spanId, flags] = first.split('-');
      assert.equal(version, '00');
      assert.match(traceId, /^[0-9a-f]{32}$/);
      assert.match(spanId, /^[0-9a-f]{16}$/);
      assert.equal(flags, mode === 'enabled' ? '01' : '00');
      seen[mode] = traceId;
      if (mode === 'enabled') {
        const trace = calls.find((c) => c.url.endsWith('/v1/traces'));
        const span = trace.body.resourceSpans[0].scopeSpans[0].spans[0];
        // The propagated trace id is the one actually exported.
        assert.equal(span.traceId, traceId);
      }
    } finally {
      restore();
      if (prevOptOut === undefined) delete process.env.LOREKIT_TELEMETRY;
      else process.env.LOREKIT_TELEMETRY = prevOptOut;
      if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
      else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
    }
  }
  // Each run is its own trace — the ids must not be accidentally shared.
  assert.notEqual(seen.disabled, seen.enabled);
});

test('traceCommand records a non-zero exit code as a failure verdict, not a span error', async () => {
  // `doctor` exits 1 because a check it ran came back failing — the command
  // itself worked. The span must NOT be an error (that would make the CLI's
  // error rate track unhealthy user environments); the verdict rides on the
  // outcome + exit_code attributes instead.
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const { calls, restore } = stubFetch();
  try {
    const code = await traceCommand('doctor', {}, '1.0.0', async () => 1);
    assert.equal(code, 1);
    const trace = calls.find((c) => c.url.endsWith('/v1/traces'));
    const span = trace.body.resourceSpans[0].scopeSpans[0].spans[0];
    // Exactly STATUS_CODE_OK (1) — `notEqual(…, 2)` would also pass for UNSET
    // (0), so it would not pin the documented behaviour.
    assert.equal(span.status.code, 1);
    assert.equal(span.status.message, undefined);
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
    assert.equal(attrs['lorekit.cli.outcome'].stringValue, 'failure');
    assert.equal(attrs['lorekit.cli.exit_code'].intValue, '1');
  } finally {
    restore();
    if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
  }
});

test('traceCommand records a thrown command as a span error', async () => {
  // The other half of the rule above: only a crash is an error.
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const { calls, restore } = stubFetch();
  try {
    await assert.rejects(
      traceCommand('doctor', {}, '1.0.0', async () => {
        throw new TypeError('boom');
      }),
    );
    const trace = calls.find((c) => c.url.endsWith('/v1/traces'));
    const span = trace.body.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.status.code, 2);
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
    assert.equal(attrs['lorekit.cli.outcome'].stringValue, 'error');
  } finally {
    restore();
    if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
  }
});

test('traceCommand runs with zero overhead and no fetch when disabled', async () => {
  const prev = process.env.LOREKIT_TELEMETRY;
  process.env.LOREKIT_TELEMETRY = 'off';
  const { calls, restore } = stubFetch();
  try {
    const code = await traceCommand('install', {}, '1.0.0', async () => 0);
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
  } finally {
    restore();
    if (prev === undefined) delete process.env.LOREKIT_TELEMETRY;
    else process.env.LOREKIT_TELEMETRY = prev;
  }
});

test('traceCommand unwraps an { exitCode } object to a number when disabled', async () => {
  // Regression: `doctor` resolves to { exitCode, ...diagnostics }. With telemetry
  // disabled (the common case — no OTLP endpoint), the fast path must still
  // unwrap it to a number. Returning the raw object let it flow to
  // process.exit(obj) in bin/lorekit.mjs → ERR_INVALID_ARG_TYPE crash (exit 1),
  // which broke `doctor --deep` in CI smoke and for every un-instrumented user.
  const prev = process.env.LOREKIT_TELEMETRY;
  process.env.LOREKIT_TELEMETRY = 'off';
  try {
    const ok = await traceCommand('doctor', { deep: true }, '1.0.0', async () => ({
      exitCode: 0,
      'lorekit.cli.doctor.failed_checks': 'none',
    }));
    assert.equal(typeof ok, 'number');
    assert.equal(ok, 0);
    const failed = await traceCommand('doctor', {}, '1.0.0', async () => ({ exitCode: 1 }));
    assert.equal(failed, 1);
  } finally {
    if (prev === undefined) delete process.env.LOREKIT_TELEMETRY;
    else process.env.LOREKIT_TELEMETRY = prev;
  }
});

test('traceCommand never lets a telemetry failure break the command', async () => {
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const code = await traceCommand('doctor', {}, '1.0.0', async () => 0);
    assert.equal(code, 0); // command result unaffected by export failure
  } finally {
    globalThis.fetch = original;
    if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
  }
});

test('traceCommand never leaks a thrown error message (paths) into the exported span', async () => {
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const { calls, restore } = stubFetch();
  try {
    const err = new Error("ENOENT: no such file or directory, open '/home/me/proj/.mcp.json'");
    err.code = 'ENOENT';
    await assert.rejects(
      () => traceCommand('install', {}, '1.0.0', async () => { throw err; }),
      /ENOENT/,
    );
    const trace = calls.find((c) => c.url.endsWith('/v1/traces'));
    assert.ok(trace, 'a trace should still be exported on the throw path');
    // The absolute path from the error message must never reach the payload.
    assert.ok(!JSON.stringify(trace.body).includes('/home/me/proj'));
    const span = trace.body.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.status.code, 2);
    assert.equal(span.status.message, 'ENOENT'); // bounded identifier, not the raw message
  } finally {
    restore();
    if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
  }
});

test('traceCommand propagates a handler throw but still returns/exports', async () => {
  const prev = process.env.LOREKIT_TELEMETRY;
  process.env.LOREKIT_TELEMETRY = 'off'; // keep it simple: disabled path
  try {
    await assert.rejects(
      () => traceCommand('install', {}, '1.0.0', async () => { throw new Error('boom'); }),
      /boom/,
    );
  } finally {
    if (prev === undefined) delete process.env.LOREKIT_TELEMETRY;
    else process.env.LOREKIT_TELEMETRY = prev;
  }
});

// ── telemetry.disabled in .lorekit.json ───────────────────────────────────────

test('telemetry.disabled: true suppresses export even when endpoint is configured', () => {
  const cfg = resolveTelemetryConfig(ENABLED_ENV, { 'telemetry.disabled': true });
  assert.equal(cfg.enabled, false);
});

test('telemetry.disabled: false does not suppress export', () => {
  const cfg = resolveTelemetryConfig(ENABLED_ENV, { 'telemetry.disabled': false });
  assert.equal(cfg.enabled, true);
});

test('telemetry.disabled not set — no effect on telemetry', () => {
  const cfg = resolveTelemetryConfig(ENABLED_ENV, {});
  assert.equal(cfg.enabled, true);
});

// A disabled config says WHY. `doctor` renders a different message per cause,
// and the causes are not distinguishable from the outside — in particular a
// set-but-unparsable OTEL_EXPORTER_OTLP_HEADERS leaves the token source
// reporting that variable while no credential actually resolved, so a caller
// inferring the cause from the token source calls it an opt-out.
test('a disabled config names its cause, and a set-but-unusable header is not an opt-out', () => {
  assert.equal(resolveTelemetryConfig({ ...ENABLED_ENV, LOREKIT_TELEMETRY: '0' }).reason, 'opted-out');
  assert.equal(resolveTelemetryConfig({ ...ENABLED_ENV, DO_NOT_TRACK: '1' }).reason, 'opted-out');
  assert.equal(resolveTelemetryConfig(ENABLED_ENV, { 'telemetry.disabled': true }).reason, 'opted-out');

  const garbage = resolveTelemetryConfig({ OTEL_EXPORTER_OTLP_HEADERS: 'garbage' });
  assert.equal(garbage.enabled, false);
  assert.equal(garbage.reason, 'no-credential', 'a header that parses to nothing is a credential problem');
  assert.equal(
    resolveTelemetryTokenSource({ OTEL_EXPORTER_OTLP_HEADERS: 'garbage' }),
    'OTEL_EXPORTER_OTLP_HEADERS',
    'the token source still names the variable — which is exactly why it cannot stand in for the reason',
  );
});

test('env LOREKIT_TELEMETRY=0 still wins over telemetry.disabled: false', () => {
  const cfg = resolveTelemetryConfig(
    { ...ENABLED_ENV, LOREKIT_TELEMETRY: '0' },
    { 'telemetry.disabled': false },
  );
  assert.equal(cfg.enabled, false);
});

// ── The export probe (`doctor --telemetry`'s engine) ─────────────────────────
//
// `exportInvocation` swallows every transport error so command telemetry can
// never disturb the CLI. `probeTelemetryExport` is the deliberate counterpart:
// the one place that reports what the collector actually said, so a revoked
// token or a moved endpoint has a failure signal instead of just going quiet.

// A stand-in OTLP collector that records what it received and answers `status`.
function otlpServer(status = 200, body = '{}') {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        path: req.url,
        authorization: req.headers['authorization'],
        dataset: req.headers['dash0-dataset'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(body);
    });
  });
  const listen = () =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return { server, received, listen };
}

test('probeTelemetryExport POSTs one tagged span and reports acceptance', async () => {
  const { server, received, listen } = otlpServer(200);
  const port = await listen();
  try {
    const res = await probeTelemetryExport({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}`,
      headers: { Authorization: 'Bearer probe_tok', 'Dash0-Dataset': 'default' },
    });

    assert.equal(res.ok, true);
    assert.equal(res.httpStatus, 200);

    assert.equal(received.length, 1, 'exactly one probe request');
    assert.equal(received[0].path, '/v1/traces');
    assert.equal(received[0].authorization, 'Bearer probe_tok');
    assert.equal(received[0].dataset, 'default', 'dataset routing is honoured');

    // Tagged so these synthetic spans are trivially excluded from adoption
    // dashboards, and carrying no PII beyond the bounded command attributes.
    const payload = JSON.parse(received[0].body);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.name, 'lorekit.cli.doctor.telemetry_probe');
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
    assert.deepEqual(attrs['lorekit.telemetry.probe'], { boolValue: true });
  } finally {
    server.close();
  }
});

test('probeTelemetryExport reports a 401 as unauthorized, not as a generic failure', async () => {
  const { server, listen } = otlpServer(401);
  const port = await listen();
  try {
    const res = await probeTelemetryExport({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}`,
      headers: {},
    });
    assert.equal(res.unauthorized, true, 'a revoked token must be distinguishable');
    assert.equal(res.ok, false);
    assert.equal(res.httpStatus, 401);
  } finally {
    server.close();
  }
});

test('probeTelemetryExport reports a 500 as a plain rejection, never as a bad token', async () => {
  const { server, listen } = otlpServer(500);
  const port = await listen();
  try {
    const res = await probeTelemetryExport({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}`,
      headers: {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.unauthorized, false, 'a collector outage is not a credential problem');
    assert.equal(res.httpStatus, 500);
  } finally {
    server.close();
  }
});

test('probeTelemetryExport surfaces an unreachable endpoint instead of swallowing it', async () => {
  // Port 1 on loopback: nothing listens, so connect() is refused at once.
  const res = await probeTelemetryExport(
    { enabled: true, endpoint: 'http://127.0.0.1:1', headers: {} },
    { timeoutMs: 2000 },
  );
  assert.ok(res.networkError, 'the caller must see the transport error');
  assert.equal(res.ok, undefined);
});

// OTLP/HTTP reports a dropped span as a 2xx carrying `partialSuccess`, so a
// status-only verdict turns a rejected probe into a green CI gate — the one
// outcome `doctor --telemetry` exists to make impossible.
test('probeTelemetryExport treats a 200 with rejectedSpans as a rejection, not an acceptance', async () => {
  const { server, listen } = otlpServer(
    200,
    JSON.stringify({ partialSuccess: { rejectedSpans: '1', errorMessage: 'dataset not found' } }),
  );
  const port = await listen();
  try {
    const res = await probeTelemetryExport({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}`,
      headers: {},
    });
    assert.equal(res.ok, false, 'the probe span was dropped — the gate must not go green');
    assert.equal(res.httpStatus, 200);
    assert.equal(res.rejectedSpans, 1, 'the int64-as-string count is coerced, not compared as text');
    assert.equal(res.rejectionMessage, 'dataset not found');
    assert.equal(res.unauthorized, false, 'a dropped span is not a credential problem');
  } finally {
    server.close();
  }
});

test('probeTelemetryExport keeps accepting a 200 whose partialSuccess rejected nothing', async () => {
  const { server, listen } = otlpServer(200, JSON.stringify({ partialSuccess: {} }));
  const port = await listen();
  try {
    const res = await probeTelemetryExport({
      enabled: true,
      endpoint: `http://127.0.0.1:${port}`,
      headers: {},
    });
    assert.equal(res.ok, true, 'an empty partialSuccess envelope is a full success');
    assert.equal(res.rejectedSpans, undefined);
  } finally {
    server.close();
  }
});

// The downgrade is one-directional on purpose: a collector that answers 2xx
// with an empty or non-OTLP body is healthy, and must never be failed on the
// grounds that we could not parse it.
test('probeTelemetryExport falls back to the HTTP status when the body is not OTLP JSON', async () => {
  for (const body of ['', 'OK', '<html>accepted</html>']) {
    const { server, listen } = otlpServer(200, body);
    const port = await listen();
    try {
      const res = await probeTelemetryExport({
        enabled: true,
        endpoint: `http://127.0.0.1:${port}`,
        headers: {},
      });
      assert.equal(res.ok, true, `an unparseable body (${JSON.stringify(body)}) must not fail the gate`);
      assert.equal(res.rejectedSpans, undefined);
    } finally {
      server.close();
    }
  }
});

test('probeTelemetryExport is a no-op when export is disabled', async () => {
  assert.deepEqual(await probeTelemetryExport({ enabled: false }), { skipped: true });
  assert.deepEqual(await probeTelemetryExport(null), { skipped: true });
});

test('resolveTelemetryTokenSource names the credential source in priority order', () => {
  assert.equal(
    resolveTelemetryTokenSource({
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer a',
      LOREKIT_TELEMETRY_TOKEN: 'b',
    }),
    'OTEL_EXPORTER_OTLP_HEADERS',
    'explicit headers outrank the bare token, matching resolveTelemetryConfig',
  );
  assert.equal(resolveTelemetryTokenSource({ LOREKIT_TELEMETRY_TOKEN: 'b' }), 'LOREKIT_TELEMETRY_TOKEN');
  assert.equal(resolveTelemetryTokenSource({ LOREKIT_TELEMETRY_TOKEN: '   ' }), 'none', 'blank is not a credential');
  // The committed token is empty (no secret in git), so a bare env resolves none.
  assert.equal(resolveTelemetryTokenSource({}), 'none');
});

test('inject-telemetry-token --require refuses to publish a telemetry-blind CLI', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../../../scripts/inject-telemetry-token.mjs', import.meta.url));

  const withoutSecret = spawnSync(process.execPath, [script, '--require'], {
    encoding: 'utf8',
    env: { ...process.env, LOREKIT_TELEMETRY_TOKEN: '' },
  });
  assert.equal(withoutSecret.status, 1, 'a missing secret must fail the release, not no-op');
  assert.match(withoutSecret.stderr, /LOREKIT_TELEMETRY_TOKEN/);

  // Without the flag the old forgiving behaviour is preserved for local runs.
  const lenient = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, LOREKIT_TELEMETRY_TOKEN: '' },
  });
  assert.equal(lenient.status, 0);
});

// ── lorekit.cli.outcome is a CLOSED vocabulary, pinned to the docs ───────────
// `lorekit.cli.outcome` is the attribute every CLI failure query has to be
// built on, because a reported verdict deliberately does NOT set the span
// status (see the STATUS_CODE_ERROR block above). That makes it a real
// contract with consumers outside this repo — dashboards and check rules —
// and until now its vocabulary existed only as three inline string literals,
// discoverable from emitted telemetry and nowhere else.
//
// Read from telemetry alone the set is easy to misread: a `doctor` that
// CRASHED in one release and FAILED GRACEFULLY in the next reports `error`
// then `failure` for the same user-visible symptom, which looks like the
// attribute drifting when it is actually the CLI improving. These guards make
// the set explicit and keep `docs/otel.md` from describing a vocabulary the
// code no longer emits.

test('CLI_OUTCOMES is exactly the three documented values, and frozen', () => {
  assert.deepEqual(CLI_OUTCOME_VALUES, ['ok', 'failure', 'error']);
  assert.equal(Object.isFrozen(CLI_OUTCOMES), true);
  assert.equal(Object.isFrozen(CLI_OUTCOME_VALUES), true);
});

test('traceCommand only ever emits an outcome from the closed vocabulary', async () => {
  // One run per branch of traceCommand: clean exit, reported verdict, crash.
  const seen = [];
  const capture = (attrs) => seen.push(attrs['lorekit.cli.outcome']);

  const env = { ...process.env, LOREKIT_TELEMETRY: '0' };
  const original = process.env;
  process.env = env;
  try {
    // Exit 0 → ok.
    capture(commandAttributes({ command: 'list', args: {}, outcome: CLI_OUTCOMES.OK, exitCode: 0 }));
    // Non-zero exit → failure (the verdict branch).
    capture(commandAttributes({ command: 'lint', args: {}, outcome: CLI_OUTCOMES.FAILURE, exitCode: 1 }));
    // Throw → error (the crash branch).
    capture(commandAttributes({ command: 'doctor', args: {}, outcome: CLI_OUTCOMES.ERROR, exitCode: 1 }));
  } finally {
    process.env = original;
  }

  assert.deepEqual(seen, ['ok', 'failure', 'error']);
  for (const outcome of seen) {
    assert.ok(CLI_OUTCOME_VALUES.includes(outcome), `unexpected outcome: ${outcome}`);
  }
});

test('telemetry.mjs assigns outcome only from CLI_OUTCOMES, never a bare literal', async () => {
  // Source scan rather than a behavioural assertion: a fourth value added at a
  // new call site would not fail any existing test, and the failure mode is
  // silent — an unbounded attribute value simply appears in the data one day.
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'telemetry.mjs'),
    'utf8',
  );

  // Strip comments first: the docblocks in this file legitimately QUOTE the
  // attribute (`lorekit.cli.outcome=failure`), and a scan that cannot tell
  // prose from code would fail on its own documentation. Over-stripping is
  // caught by the anti-vacuity floor below.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const assignments = [...code.matchAll(/\boutcome\s*=\s*(?!=)([^;\n]+)/g)].map((m) => m[1].trim());
  // Anti-vacuity: the three real assignments in traceCommand must be found.
  assert.ok(assignments.length >= 3, `expected >= 3 outcome assignments, found ${assignments.length}`);
  for (const rhs of assignments) {
    assert.ok(
      rhs.startsWith('CLI_OUTCOMES.'),
      `outcome must be assigned from CLI_OUTCOMES, found: ${rhs}`,
    );
  }
});

test('docs/otel.md documents exactly the vocabulary the code emits', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const docs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'otel.md'),
    'utf8',
  );

  const row = docs.split('\n').find((line) => line.includes('`lorekit.cli.outcome`'));
  assert.ok(row, 'docs/otel.md must document lorekit.cli.outcome');

  // Every value the code can emit is named in the row...
  for (const value of CLI_OUTCOME_VALUES) {
    assert.ok(row.includes(`\`${value}\``), `docs/otel.md omits the ${value} outcome`);
  }
  // ...and the row names no value the code cannot emit. `ok` is a substring of
  // nothing else here, so a simple scan of the backticked tokens is enough.
  const documented = [...row.matchAll(/`([a-z_]+)`/g)]
    .map((m) => m[1])
    .filter((token) => token !== 'lorekit' && token !== 'doctor' && token !== 'lint');
  for (const token of documented) {
    assert.ok(
      CLI_OUTCOME_VALUES.includes(token),
      `docs/otel.md documents an outcome the code cannot emit: ${token}`,
    );
  }
});
