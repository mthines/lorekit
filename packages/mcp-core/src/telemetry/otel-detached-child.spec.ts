import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * EXECUTING cover for `Span.detachedChild()` + `ExportBatch.flushAsync()`.
 *
 * These two exist to fix a silent span-loss bug, and until now they were held
 * only by the regex assertions in `otel-conventions.spec.ts` — which can prove
 * the `fetch` is routed through `post()` but not that a detached child actually
 * owns a SEPARATE batch, nor that `flushAsync` really awaits its export. Both
 * are exactly the kind of property a plausible refactor breaks without changing
 * the shape a source scan looks at.
 *
 * The bug they fix: `traceRequest` ends the request span and DRAINS its batch in
 * a `finally`, which runs before a `waitUntil` callback resolves. Anything a
 * background task records on the request span lands in a batch nobody flushes
 * again — so `lorekit.embedding.enqueued` (set before the flush) survived and
 * the OUTCOME never did. `embed-on-write.ts` is the caller that depends on this,
 * and after 00062 the miss signal it reports depends on it too.
 *
 * The module is Deno-flavoured but loads under vitest: its only `npm:` import is
 * type-only, and `Deno` is touched at call time rather than at module scope —
 * which is what lets this run in `nx test mcp-core` with no Deno toolchain.
 *
 * It is reached by a DYNAMIC import over a computed path, not a static relative
 * one. `supabase/` is a separate NX project, so a static
 * `../../../supabase/...` specifier is an `@nx/enforce-module-boundaries` error
 * — correctly, since mcp-core must not depend on the edge tree at build time.
 * Nothing here does: this is a test reaching ACROSS the repo to execute a file
 * it does not own, the same shape `scripts/migrations/backfill-embeddings.mjs` uses to load
 * the pure module. The sibling guards (`edge-parity`, `otel-conventions`) read
 * these files with `readFileSync` for the same boundary reason; they can only
 * assert on source text, which is precisely the gap this spec exists to close.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { Span, ExportBatch } = await import(
  pathToFileURL(path.join(repoRoot, 'supabase', 'functions', '_shared', 'telemetry', 'otel.ts')).href
) as {
  Span: new (
    name: string,
    ctx: { traceId: string; spanId: string; parentSpanId?: string; sampled: boolean },
    batch: InstanceType<typeof ExportBatch>,
    kind?: number,
  ) => {
    detachedChild(n: string, a?: Record<string, string | number | boolean>): {
      span: { error(m: string): unknown; end(): unknown };
      flush: () => Promise<void>;
    };
  };
  ExportBatch: new () => { environmentOverride?: string; drain(): unknown[] };
};

const TRACE_ID = 'a'.repeat(32);
const ROOT_SPAN_ID = 'b'.repeat(16);
const ENDPOINT = 'https://otlp.test.invalid';

interface Posted { url: string; body: string }

let posted: Posted[];
let realFetch: typeof globalThis.fetch;
let hadDeno: boolean;

/** Every span object in an OTLP JSON payload, however deeply nested. */
function spansIn(body: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o.name === 'string' && (o.spanId ?? o.span_id)) out.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(JSON.parse(body));
  return out;
}

beforeEach(() => {
  posted = [];
  realFetch = globalThis.fetch;
  hadDeno = 'Deno' in globalThis;
  (globalThis as Record<string, unknown>).Deno = {
    env: {
      get: (k: string) =>
        k === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? ENDPOINT
          : k === 'OTEL_EXPORTER_OTLP_HEADERS' ? 'Authorization=Bearer test'
            : undefined,
    },
  };
  globalThis.fetch = ((url: string, init?: { body?: string }) => {
    posted.push({ url: String(url), body: String(init?.body ?? '') });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (!hadDeno) delete (globalThis as Record<string, unknown>).Deno;
});

function rootSpan(): { root: Span; batch: ExportBatch } {
  const batch = new ExportBatch();
  const root = new Span(
    'root',
    { traceId: TRACE_ID, spanId: ROOT_SPAN_ID, sampled: true },
    batch,
    1,
  );
  return { root, batch };
}

describe('Span.detachedChild', () => {
  it('records the child into its OWN batch, not the parent request batch', async () => {
    const { root, batch } = rootSpan();

    const { span: bg, flush } = root.detachedChild('lorekit.embedding.write', { 'lorekit.memory_id': 'm1' });
    bg.error('embedding update matched no row');
    bg.end();

    // THE PROPERTY. If the child shared the parent's batch, the request span's
    // own flush would carry (or have already discarded) the child's outcome —
    // which is the whole bug. The parent batch must be untouched by the child.
    expect(
      batch.drain(),
      'a detached child must not write into the parent request batch',
    ).toEqual([]);

    await flush();

    const spans = posted.flatMap((p) => spansIn(p.body));
    expect(spans.map((s) => s.name)).toContain('lorekit.embedding.write');
  });

  it('parents the child to the caller and keeps the trace id', async () => {
    const { root } = rootSpan();
    const { span: bg, flush } = root.detachedChild('child');
    bg.end();
    await flush();

    const [child] = posted.flatMap((p) => spansIn(p.body))
      .filter((s) => s.name === 'child');
    expect(child, 'the child span must be exported').toBeTruthy();
    expect(child!.traceId ?? child!.trace_id).toBe(TRACE_ID);
    expect(child!.parentSpanId ?? child!.parent_span_id).toBe(ROOT_SPAN_ID);
    // Its own span id — a child that reused the parent's would collapse the two
    // into one span at the collector.
    expect(child!.spanId ?? child!.span_id).not.toBe(ROOT_SPAN_ID);
  });

  it('inherits the request batch environment override', async () => {
    const { root, batch } = rootSpan();
    batch.environmentOverride = 'test';
    const { span: bg, flush } = root.detachedChild('child');
    bg.end();
    await flush();

    // A smoke run tags its telemetry `test`; a detached child that dropped the
    // override would report the deployment's real environment instead and the
    // sweep would not recognise its own spans.
    expect(posted[0]!.body).toContain('test');
  });

  it('flush() RESOLVES only after the export settles', async () => {
    const { root } = rootSpan();
    let releasePost!: () => void;
    const gate = new Promise<void>((r) => { releasePost = r; });
    globalThis.fetch = ((url: string, init?: { body?: string }) =>
      gate.then(() => {
        posted.push({ url: String(url), body: String(init?.body ?? '') });
        return { ok: true, status: 200, text: () => Promise.resolve('') };
      })) as unknown as typeof globalThis.fetch;

    const { span: bg, flush } = root.detachedChild('child');
    bg.end();

    let settled = false;
    const p = flush().then(() => { settled = true; });

    // A background task IS the isolate's keep-alive, so a fire-and-forget POST
    // here can be torn down mid-flight. If this resolved before the request
    // settled, the spans would be lost exactly as if never recorded.
    await Promise.resolve();
    expect(settled, 'flush() must not resolve before the export request settles').toBe(false);

    releasePost();
    await p;
    expect(settled).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it('flush() is a no-op when the child recorded nothing', async () => {
    const { root } = rootSpan();
    const { flush } = root.detachedChild('child');
    await flush();
    expect(posted, 'an empty batch must not POST').toEqual([]);
  });
});
