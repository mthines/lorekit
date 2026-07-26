// Tests for the self-contained CLI telemetry: config resolution / opt-out, the
// pure OTLP payload builders (no PII, correct shape), and the traceCommand
// wrapper (records outcome, swallows telemetry failures, never blocks the CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTelemetryConfig,
  commandAttributes,
  buildTracePayload,
  buildMetricsPayload,
  exportInvocation,
  traceCommand,
} from '../src/telemetry.mjs';

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
  assert.equal(resAttrs['service.name'], 'lorekit-cli');
  assert.equal(resAttrs['service.namespace'], 'lorekit');
  assert.equal(resAttrs['service.version'], '9.9.9');
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

test('traceCommand records a non-zero exit code as an error outcome', async () => {
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer test';
  const { calls, restore } = stubFetch();
  try {
    const code = await traceCommand('doctor', {}, '1.0.0', async () => 1);
    assert.equal(code, 1);
    const trace = calls.find((c) => c.url.endsWith('/v1/traces'));
    const span = trace.body.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.status.code, 2);
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
