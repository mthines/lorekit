import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * EXECUTING cover for the edge's OTLP log export: `Span.log()` records ride the
 * request's span batch and leave through the same `ExportBatch.post()` as the
 * spans — one request to `/v1/traces`, one to `/v1/logs`, on the same resource
 * and with the same headers. Asserted on what `fetch` would send to Dash0, not
 * on an internal list, because every failure here is silent: the records still
 * arrive, filed under a resource nobody looks at or detached from their trace.
 * The regex guards in `otel-conventions.spec.ts` pin the shape; this pins the
 * behaviour.
 *
 * Loaded exactly like `otel-detached-child.spec.ts` (dynamic import over a
 * computed path, `Deno` shimmed at call time) — see that file's header for why
 * a static relative import across the NX project boundary is wrong here.
 */

interface SpanLike {
  log(severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', message: string, attrs?: Record<string, string | number | boolean>): unknown;
  end(): unknown;
  detachedChild(n: string): { span: SpanLike; flush: () => Promise<void> };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { Span, ExportBatch } = await import(
  pathToFileURL(path.join(repoRoot, 'supabase', 'functions', '_shared', 'telemetry', 'otel.ts')).href
) as {
  Span: new (
    name: string,
    ctx: { traceId: string; spanId: string; parentSpanId?: string; sampled: boolean },
    batch: InstanceType<typeof ExportBatch>,
    kind?: number,
  ) => SpanLike;
  ExportBatch: new () => { environmentOverride?: string; flushAsync(): Promise<void> };
};

const TRACE_ID = 'a'.repeat(32);
const ROOT_SPAN_ID = 'b'.repeat(16);
const ENDPOINT = 'https://otlp.test.invalid';

interface Posted {
  path: string;
  headers: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an OTLP JSON payload, read field by field below
  body: any;
}

let posted: Posted[];
let realFetch: typeof globalThis.fetch;
let hadDeno: boolean;

beforeEach(() => {
  posted = [];
  realFetch = globalThis.fetch;
  hadDeno = 'Deno' in globalThis;
  (globalThis as Record<string, unknown>)['Deno'] = {
    env: {
      get: (k: string) =>
        k === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? ENDPOINT
          : k === 'OTEL_EXPORTER_OTLP_HEADERS' ? 'Authorization=Bearer test'
            : undefined,
    },
  };
  globalThis.fetch = ((url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    posted.push({
      path: new URL(String(url)).pathname,
      headers: init?.headers ?? {},
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (!hadDeno) delete (globalThis as Record<string, unknown>)['Deno'];
});

/** Record on a fresh root span, end it, flush, and return what was posted. */
async function exportRequest(
  record: (span: SpanLike) => void,
  opts: { environmentOverride?: string } = {},
): Promise<Posted[]> {
  const batch = new ExportBatch();
  batch.environmentOverride = opts.environmentOverride;
  const root = new Span('lorekit.test', { traceId: TRACE_ID, spanId: ROOT_SPAN_ID, sampled: true }, batch, 2);
  record(root);
  root.end();
  await batch.flushAsync();
  return posted;
}

function postedTo(p: Posted[], to: string): Posted {
  const request = p.find((r) => r.path === to);
  expect(request, `no export request to ${to}; got ${p.map((r) => r.path).join(', ')}`).toBeDefined();
  return request as Posted;
}

function logRecordsIn(request: Posted): Array<Record<string, unknown>> {
  return request.body.resourceLogs[0].scopeLogs[0].logRecords;
}

describe('Span.log — OTLP log export from the edge', () => {
  it('posts a log record to /v1/logs, linked to the span that wrote it', async () => {
    const p = await exportRequest((span) => {
      span.log('ERROR', 'storage configuration error: LOREKIT_STORAGE_KEY is not set', {
        'error.type': 'storage_config',
      });
    });

    expect(p.map((r) => r.path).sort()).toEqual(['/v1/logs', '/v1/traces']);
    const logs = postedTo(p, '/v1/logs');
    expect(logs.headers['Authorization']).toBe('Bearer test');
    expect(logs.headers['Content-Type']).toBe('application/json');

    const [record] = logRecordsIn(logs);
    expect(record).toMatchObject({
      traceId: TRACE_ID,
      spanId: ROOT_SPAN_ID,
      flags: 1,
      severityNumber: 17,
      severityText: 'ERROR',
      body: { stringValue: 'storage configuration error: LOREKIT_STORAGE_KEY is not set' },
      attributes: [{ key: 'error.type', value: { stringValue: 'storage_config' } }],
    });
    // OTLP/JSON renders int64 as a JSON string; a bare number is a silent 400.
    expect(record?.['timeUnixNano']).toMatch(/^\d+$/);
  });

  it('carries the same resource and headers as the spans', async () => {
    const p = await exportRequest((span) => span.log('INFO', 'hello'), { environmentOverride: 'test' });

    const traces = postedTo(p, '/v1/traces');
    const logs = postedTo(p, '/v1/logs');
    expect(logs.body.resourceLogs[0].resource).toEqual(traces.body.resourceSpans[0].resource);
    expect(logs.headers).toEqual(traces.headers);

    const attrs: Array<{ key: string; value: { stringValue: string } }> = logs.body.resourceLogs[0].resource.attributes;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
    expect(byKey).toMatchObject({
      'service.name': 'api',
      'service.namespace': 'lorekit',
      'deployment.environment.name': 'test',
    });
  });

  it('URL-redacts the message, like error()', async () => {
    const p = await exportRequest((span) => {
      span.log('WARN', 'fetch failed: https://x.supabase.co/rest/v1/memories?key=eq.private-key');
    });

    const [record] = logRecordsIn(postedTo(p, '/v1/logs'));
    expect(record?.['body']).toEqual({ stringValue: 'fetch failed: <url>' });
    expect(record?.['severityNumber']).toBe(13);
  });

  it('sends no /v1/logs request for a request that logged nothing', async () => {
    const p = await exportRequest(() => undefined);

    expect(p.map((r) => r.path)).toEqual(['/v1/traces']);
  });

  it('does not re-send log records once the batch has flushed', async () => {
    const batch = new ExportBatch();
    const root = new Span('lorekit.test', { traceId: TRACE_ID, spanId: ROOT_SPAN_ID, sampled: true }, batch, 2);
    root.log('INFO', 'once');

    await batch.flushAsync();
    await batch.flushAsync();

    // The span was never ended, so the only export is the single log request.
    expect(posted.map((r) => r.path)).toEqual(['/v1/logs']);
  });

  it("a detachedChild's log records leave on the child's own flush, not the request batch", async () => {
    const batch = new ExportBatch();
    const root = new Span('lorekit.test', { traceId: TRACE_ID, spanId: ROOT_SPAN_ID, sampled: true }, batch, 2);
    const { span: background, flush } = root.detachedChild('lorekit.embedding.write');

    background.log('WARN', 'embedding update matched no row');
    await batch.flushAsync();
    expect(posted, 'the request batch must not carry the background log').toEqual([]);

    await flush();
    const [record] = logRecordsIn(postedTo(posted, '/v1/logs'));
    expect(record).toMatchObject({ traceId: TRACE_ID, body: { stringValue: 'embedding update matched no row' } });
  });
});
