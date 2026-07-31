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
  getActiveTraceparent,
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

test('env LOREKIT_TELEMETRY=0 still wins over telemetry.disabled: false', () => {
  const cfg = resolveTelemetryConfig(
    { ...ENABLED_ENV, LOREKIT_TELEMETRY: '0' },
    { 'telemetry.disabled': false },
  );
  assert.equal(cfg.enabled, false);
});
