/**
 * `Span.log()` records ride the request's span batch and leave through the same
 * `post()` as the spans: one request to `/v1/traces`, one to `/v1/logs`, on the
 * same resource and with the same headers. Exercised through the real
 * `flushAsync()` with `fetch` stubbed, so the assertion is on what would reach
 * Dash0 rather than on an internal list.
 *
 * Run with: deno test --no-check --allow-env supabase/functions/_shared/telemetry/otel.logs.test.ts
 * (--no-check for the reason given in otel.error-classification.test.ts;
 * --allow-env because the export path reads OTEL_EXPORTER_OTLP_*).
 */
import { assert, assertEquals, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ExportBatch, Span } from './otel.ts';

interface CapturedRequest {
  path: string;
  headers: Record<string, string>;
  // deno-lint-ignore no-explicit-any
  body: any;
}

const TRACE_ID = 'a'.repeat(32);
const SPAN_ID = 'b'.repeat(16);

/** Record on a fresh root span, end it, flush, and return every export request. */
async function exportOneRequest(
  record: (span: Span) => void,
  opts: { environmentOverride?: string } = {},
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  Deno.env.set('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otlp.example.test/');
  Deno.env.set('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer auth_test');
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      path: new URL(String(input)).pathname,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;

  try {
    const batch = new ExportBatch();
    batch.environmentOverride = opts.environmentOverride;
    const span = new Span('lorekit.test', { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }, batch, 2);
    record(span);
    span.end();
    await batch.flushAsync();
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete('OTEL_EXPORTER_OTLP_ENDPOINT');
    Deno.env.delete('OTEL_EXPORTER_OTLP_HEADERS');
  }
  return captured;
}

function requestTo(captured: CapturedRequest[], path: string): CapturedRequest {
  const request = captured.find((c) => c.path === path);
  assert(request, `no export request to ${path}; got ${captured.map((c) => c.path).join(', ')}`);
  return request;
}

Deno.test('Span.log posts a log record to /v1/logs, linked to the span that wrote it', async () => {
  const captured = await exportOneRequest((span) => {
    span.log('ERROR', 'storage configuration error: LOREKIT_STORAGE_KEY is not set', {
      'error.type': 'storage_config',
    });
  });

  assertEquals(captured.map((c) => c.path).sort(), ['/v1/logs', '/v1/traces']);
  const logs = requestTo(captured, '/v1/logs');
  assertEquals(logs.headers['Authorization'], 'Bearer auth_test');
  assertEquals(logs.headers['Content-Type'], 'application/json');

  const [record] = logs.body.resourceLogs[0].scopeLogs[0].logRecords;
  assertEquals(record.traceId, TRACE_ID);
  assertEquals(record.spanId, SPAN_ID);
  assertEquals(record.flags, 1);
  assertEquals(record.severityNumber, 17);
  assertEquals(record.severityText, 'ERROR');
  assertEquals(record.body, { stringValue: 'storage configuration error: LOREKIT_STORAGE_KEY is not set' });
  assertEquals(record.attributes, [{ key: 'error.type', value: { stringValue: 'storage_config' } }]);
  assert(/^\d+$/.test(record.timeUnixNano), 'timeUnixNano must be an int64 rendered as a JSON string');
});

Deno.test('log records carry the same resource and headers as the spans', async () => {
  const captured = await exportOneRequest((span) => span.log('INFO', 'hello'), { environmentOverride: 'test' });

  const traces = requestTo(captured, '/v1/traces');
  const logs = requestTo(captured, '/v1/logs');
  assertEquals(logs.body.resourceLogs[0].resource, traces.body.resourceSpans[0].resource);
  assertEquals(logs.headers, traces.headers);

  const attrs: Array<{ key: string; value: { stringValue: string } }> = logs.body.resourceLogs[0].resource.attributes;
  const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
  assertEquals(byKey['service.name'], 'api');
  assertEquals(byKey['service.namespace'], 'lorekit');
  assertEquals(byKey['deployment.environment.name'], 'test');
});

Deno.test('the log message is URL-redacted, like error()', async () => {
  const captured = await exportOneRequest((span) => {
    span.log('WARN', 'fetch failed: https://x.supabase.co/rest/v1/memories?key=eq.private-key');
  });

  const [record] = requestTo(captured, '/v1/logs').body.resourceLogs[0].scopeLogs[0].logRecords;
  assertEquals(record.body.stringValue, 'fetch failed: <url>');
  assertEquals(record.severityNumber, 13);
});

Deno.test('a request that logged nothing sends no /v1/logs request', async () => {
  const captured = await exportOneRequest(() => {});

  assertEquals(captured.map((c) => c.path), ['/v1/traces']);
});

Deno.test('a flushed batch does not re-send its log records', async () => {
  const realFetch = globalThis.fetch;
  const paths: string[] = [];
  Deno.env.set('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://otlp.example.test');
  globalThis.fetch = ((input: string | URL | Request) => {
    paths.push(new URL(String(input)).pathname);
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;

  try {
    const batch = new ExportBatch();
    const span = new Span('lorekit.test', { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true }, batch, 2);
    span.log('INFO', 'once');
    await batch.flushAsync();
    await batch.flushAsync();
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete('OTEL_EXPORTER_OTLP_ENDPOINT');
  }

  assertEquals(paths, ['/v1/logs']);
  assertFalse(paths.includes('/v1/traces'), 'the span was never ended, so no trace export');
});
