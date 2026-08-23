import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  TRACER_NAME,
  METER_NAME,
  getTracer,
  getMeter,
  getToolDurationHistogram,
} from './telemetry.js';

/**
 * Drift guards for the telemetry-quality invariants that make cross-service
 * correlation legible, plus unit coverage of the `lorekit.tool.duration`
 * accessor module.
 *
 * The correlation behaviour itself is proven in `otel-correlation.spec.ts`;
 * this file protects the wiring around it — the properties that, if they
 * silently drift, would fragment the service map or gate export on the sampled
 * flag. Same source-scan idiom as `edge-parity.spec.ts`,
 * `tenant-scope-usage.spec.ts`, and `org-actor-usage.spec.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url)); // packages/mcp-core/src
const repoRoot = path.resolve(here, '../../../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

// The four LoreKit components that emit telemetry and where each declares its
// `service.name` default. A collision here collapses two components into one
// indistinguishable node in the Dash0 service map (root CLAUDE.md, "service.name
// inventory").
const SERVICE_NAME_SITES: ReadonlyArray<readonly [string, string, RegExp, string]> = [
  ['cli', 'packages/cli/src/telemetry/telemetry.mjs', /service\.name',\s*value:\s*\{\s*stringValue:\s*'([^']+)'/, 'cli'],
  ['api (edge)', 'supabase/functions/_shared/otel.ts', /SERVICE_NAME'\)\s*\?\?\s*'([^']+)'/, 'api'],
  ['web', 'packages/web/src/instrumentation.ts', /SERVICE_NAME = '([^']+)'/, 'web'],
];

// The browser half of `web`. Deliberately NOT in SERVICE_NAME_SITES: server and
// browser are ONE service told apart by `telemetry.sdk.language`, so it must
// MATCH the server's name rather than be distinct from it.
const WEB_BROWSER_SERVICE_NAME_SITE = ['packages/web/src/lib/dash0-rum.ts', /SERVICE_NAME = '([^']+)'/] as const;

// Every place a `service.namespace` is declared — must be `lorekit` everywhere
// so all components aggregate under one namespace.
const NAMESPACE_SITES = [
  'packages/cli/src/telemetry/telemetry.mjs',
  'supabase/functions/_shared/otel.ts',
  'packages/web/src/instrumentation.ts',
  // The browser bundle's single init path. `instrumentation-client.ts` and
  // `Dash0Provider.tsx` used to each declare their own copy of the attributes
  // (and their own `init()`); both now delegate here, so this is the only
  // browser-side declaration left to pin.
  'packages/web/src/lib/dash0-rum.ts',
];

describe('service.name inventory', () => {
  it.each(SERVICE_NAME_SITES)('%s declares its documented service name', (_label, file, pattern, expected) => {
    const match = read(file).match(pattern);
    expect(match, `no service.name default found in ${file}`).not.toBeNull();
    expect(match![1]).toBe(expected);
  });

  it('every component reports a DISTINCT service.name (no service-map collision)', () => {
    const names = SERVICE_NAME_SITES.map(([, file, pattern]) => read(file).match(pattern)?.[1]);
    expect(names).toEqual(['cli', 'api', 'web']);
    expect(new Set(names).size).toBe(SERVICE_NAME_SITES.length);
  });

  it('the web browser bundle reports the SAME service.name as the web server runtime', () => {
    // Server and browser are one service. When they disagree the app shows up
    // as two unrelated service-map nodes and no query spans both halves — which
    // is exactly what a stray OTEL_SERVICE_NAME produced in production
    // (server reported `lorekit`, browser reported `web`).
    const [file, pattern] = WEB_BROWSER_SERVICE_NAME_SITE;
    const browser = read(file).match(pattern);
    expect(browser, `no service.name declaration found in ${file}`).not.toBeNull();

    const [, serverFile, serverPattern] = SERVICE_NAME_SITES[2]!;
    expect(browser![1]).toBe(read(serverFile).match(serverPattern)![1]);
  });

  it('the web server runtime forces OTEL_SERVICE_NAME instead of losing to it', () => {
    // `@vercel/otel` resolves `OTEL_SERVICE_NAME || serviceName || 'app'`, so
    // passing the option alone is NOT enough — a deployment env var silently
    // wins and renames the service. `register()` must overwrite the variable
    // with the code-declared name. See packages/web/src/lib/otel-service-name.ts.
    const src = read('packages/web/src/instrumentation.ts');
    expect(src).toMatch(/resolveServiceName\(SERVICE_NAME,\s*process\.env\['OTEL_SERVICE_NAME'\]\)/);
    expect(src).toMatch(/process\.env\['OTEL_SERVICE_NAME'\]\s*=/);
  });
});

describe('service.namespace', () => {
  it.each(NAMESPACE_SITES)('%s pins service.namespace to "lorekit"', (file) => {
    // Matches both the OTLP key/value form (cli, edge) and the object form (web).
    expect(read(file)).toMatch(/service\.namespace'[^\n]*'lorekit'/);
  });
});

describe('edge span-kind assignment (SERVER root / CLIENT db / INTERNAL child)', () => {
  const otel = read('supabase/functions/_shared/otel.ts');

  it('uses the OTLP wire values (INTERNAL=1, SERVER=2, CLIENT=3)', () => {
    expect(otel).toMatch(/SPAN_KIND_INTERNAL\s*=\s*1\b/);
    expect(otel).toMatch(/SPAN_KIND_SERVER\s*=\s*2\b/);
    expect(otel).toMatch(/SPAN_KIND_CLIENT\s*=\s*3\b/);
  });

  it('makes the root request span a SERVER span', () => {
    // Without SERVER on the root, no APM can draw the inbound service edge.
    expect(otel).toMatch(/new Span\(operationName, ctx, batch, SPAN_KIND_SERVER\)/);
  });

  it('makes every DB query a CLIENT span', () => {
    // The CLIENT span is the outbound edge to Postgres.
    expect(otel).toMatch(/SPAN_KIND_CLIENT\)/);
    expect(otel).toMatch(/this\.parent\.child\(sql,[\s\S]*?SPAN_KIND_CLIENT\)/);
  });

  it('defaults child spans to INTERNAL', () => {
    expect(otel).toMatch(/kind: number = SPAN_KIND_INTERNAL/);
  });
});

describe('faas.name distinguishes the five edge functions', () => {
  const otel = read('supabase/functions/_shared/otel.ts');

  it('root span sets faas.name derived from the operation name', () => {
    expect(otel).toMatch(/'faas\.name':\s*faasNameFrom\(operationName\)/);
  });

  it('faasNameFrom strips the lorekit. prefix', () => {
    expect(otel).toMatch(/operationName\.startsWith\('lorekit\.'\)/);
  });
});

describe('edge + CLI route trace propagation through the shared W3C seam', () => {
  // The correlation contract (otel-correlation.spec.ts) is proven against
  // reference COPIES of the wiring. These source-scans keep those copies honest
  // by asserting the shipped edge/CLI code still routes propagation through the
  // single `parseTraceparent` / `formatTraceparent` seam — the property the
  // correlation proofs assume. If a component stopped using the seam (or
  // hand-rolled a divergent header/parser), CLI/MCP traces could silently
  // orphan and no behavioural copy-test would notice.
  const edge = read('supabase/functions/_shared/otel.ts');
  const cli = read('packages/cli/src/telemetry/telemetry.mjs');

  it('the edge receiver (extractTraceContext) parses inbound context via parseTraceparent', () => {
    const fn = edge.match(/function extractTraceContext\([\s\S]*?\n\}/);
    expect(fn, 'extractTraceContext not found').not.toBeNull();
    expect(fn![0]).toMatch(/parseTraceparent\(/);
  });

  it('the edge sender (withTraceparent) formats the response header via formatTraceparent', () => {
    const fn = edge.match(/function withTraceparent<[\s\S]*?\n\}/);
    expect(fn, 'withTraceparent not found').not.toBeNull();
    expect(fn![0]).toMatch(/formatTraceparent\(/);
  });

  it('the edge imports both seam functions from the shared trace-context module', () => {
    expect(edge).toMatch(/import\s*\{[^}]*\bformatTraceparent\b[^}]*\bparseTraceparent\b[^}]*\}\s*from\s*'\.\/trace-context\.ts'/);
  });

  it('the CLI (getActiveTraceparent) emits a version-00 W3C header from the active ids', () => {
    const fn = cli.match(/export function getActiveTraceparent\(\)\s*\{[\s\S]*?\n\}/);
    expect(fn, 'getActiveTraceparent not found').not.toBeNull();
    // A version-00, four-field traceparent driven by the active trace/span ids
    // and the sampled bit — the byte-identity to formatTraceparent is proven in
    // otel-correlation.spec.ts by rendering this exact template.
    expect(fn![0]).toMatch(/`00-\$\{_activeTraceId\}-\$\{_activeSpanId\}-\$\{_activeSampled \? '01' : '00'\}`/);
  });
});

describe('AlwaysOn: the sampled flag is recorded, never an export gate', () => {
  const otel = read('supabase/functions/_shared/otel.ts');

  it('records the W3C sampled bit as OTLP span flags', () => {
    expect(otel).toMatch(/flags:\s*s\.ctx\.sampled\s*\?\s*1\s*:\s*0/);
  });

  // The export POST lives in `ExportBatch.post()`, which BOTH `flush()` (the
  // fire-and-forget request-path flush) and `flushAsync()` (the awaitable one a
  // background task needs) delegate to. The guard is anchored on the method
  // that actually holds the `fetch`, and each caller is checked separately —
  // grepping only `flush()` made the `not.toMatch(/sampled/)` half VACUOUS the
  // moment the POST moved out of it, and left `flushAsync` unguarded entirely.
  const exportMethodBody = (signature: RegExp): string => {
    const m = otel.match(new RegExp(`${signature.source}\\s*\\{([\\s\\S]*?)\\n {2}\\}`));
    expect(m, `could not locate ExportBatch.${signature.source}`).not.toBeNull();
    return m![1] as string;
  };

  it('the export POST is unconditional on the sampled flag', () => {
    // Turning the flag into a drop condition is the regression this guards
    // (root CLAUDE.md: "never turn this into a drop condition").
    const post = exportMethodBody(/private post\(\): Promise<void> \| null/);
    expect(post).toMatch(/fetch\(/); // it does export
    expect(post).not.toMatch(/sampled/); // but never consults the flag
  });

  it.each([
    ['flush', /flush\(\): void/],
    ['flushAsync', /async flushAsync\(\): Promise<void>/],
  ])('%s routes through post() and does not branch on the sampled flag', (_name, signature) => {
    const body = exportMethodBody(signature);
    expect(body).toMatch(/post\(\)/); // it reaches the one export path
    expect(body).not.toMatch(/sampled/); // and adds no gate of its own
  });
});

describe('lorekit.* tool span + histogram attributes', () => {
  const toolsDir = path.join(here, '../tools');
  const toolFiles = readdirSync(toolsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  it('there is at least one instrumented tool handler', () => {
    expect(toolFiles.length).toBeGreaterThan(0);
  });

  it.each(toolFiles)('%s sets the correlation attributes and records the duration histogram', (file) => {
    const src = readFileSync(path.join(toolsDir, file), 'utf8');
    // Every tool span is named `lorekit.memory.<op>` and identified by a bounded
    // tool name on the span itself.
    expect(src).toMatch(/startActiveSpan\(\s*'lorekit\.memory\./);
    expect(src).toMatch(/setAttribute\('lorekit\.tool\.name'/);
    // …and feeds the duration histogram keyed by the two low-cardinality attrs
    // the metric is defined over. `lorekit.scope.type` is `scopeType(...)` for a
    // single-scope tool and a bounded literal ('global' / 'mixed') for a
    // cross-scope one — both are low-cardinality, which is what the metric needs.
    expect(src).toMatch(/getToolDurationHistogram\(\)/);
    expect(src).toMatch(/hist\.record\(/);
    expect(src).toMatch(/'lorekit\.tool\.name':/);
    expect(src).toMatch(/'lorekit\.scope\.type':/);
  });
});

describe('lorekit.tool.duration histogram accessor', () => {
  it('exposes the shared tracer/meter under the lorekit name', () => {
    expect(TRACER_NAME).toBe('lorekit');
    expect(METER_NAME).toBe('lorekit');
    expect(typeof getTracer().startActiveSpan).toBe('function');
    expect(typeof getMeter().createHistogram).toBe('function');
  });

  it('memoizes the histogram instance (one instrument, not one per call)', () => {
    // A fresh histogram per call would register duplicate instruments and
    // fragment the metric — the accessor must return the same object.
    expect(getToolDurationHistogram()).toBe(getToolDurationHistogram());
  });

  it('records a duration with the documented low-cardinality attributes without throwing', () => {
    const hist = getToolDurationHistogram();
    expect(() =>
      hist.record(0.012, { 'lorekit.tool.name': 'memory.list', 'lorekit.scope.type': 'repo' }),
    ).not.toThrow();
  });
});

describe('smoke test-run marker — the deployment-environment charset/bound stay in step', () => {
  // `X-LoreKit-Deployment-Environment` is normalised by two independent
  // low-/zero-dep copies (the CLI cannot import mcp-core; the sweeper runs from
  // a bare checkout), so the shared charset + bound is otherwise only
  // prose-coupled ("keep them in step"). Pin it the way edge-bare-specifier.spec
  // pins its own invariant, so a drift in one copy fails the build.
  const CHARSET = '[A-Za-z0-9_.\\-:]';
  const sites: Array<[string, string]> = [
    ['CLI restFetch (normalizeRunEnvironment)', 'packages/cli/src/shared/mcp.mjs'],
    ['orphan sweeper (runEnvHeaders)', 'scripts/smoke/smoke-cleanup.mjs'],
  ];

  it.each(sites)('%s uses the shared charset and a 64-char bound', (_label, rel) => {
    const src = read(rel);
    // Match the executable regex literal and the `.length` bound, not a bare
    // charset mention a comment could satisfy — sibling smoke-cleanup.spec.ts
    // pins the executable line for exactly this reason.
    expect(src, `${rel} must test with the shared charset regex /^${CHARSET}+$/`).toMatch(
      /\/\^\[A-Za-z0-9_\.\\-:\]\+\$\//,
    );
    expect(src, `${rel} must bound the value length at 64 chars`).toMatch(/\.length\s*(?:<=|>)\s*64/);
  });

  it('the edge honours exactly the synthetic value `test`, which the charset admits', () => {
    const otel = read('supabase/functions/_shared/otel.ts');
    expect(otel).toMatch(/HEADER_ENV_ALLOWLIST\s*=\s*new Set\(\['test'\]\)/);
  });
});

describe('self-time attribution — the edge stand-in for a CPU profile', () => {
  // No profiler can be attached to a managed Deno isolate, so the root span
  // carries the next best thing: how much of the request no child span
  // explains. The numbers are only meaningful if the wiring below holds, and
  // every one of these failures is SILENT — a plausible number that is wrong.
  const otel = () => read('supabase/functions/_shared/otel.ts');

  it('stamps the three measures on every root request span', () => {
    const src = otel();
    for (const attr of ['lorekit.io.wait_ms', 'lorekit.io.calls', 'lorekit.self_time_ms']) {
      expect(src, `traceRequest must stamp ${attr}`).toContain(`'${attr}'`);
    }
  });

  it('stamps BEFORE ending the span, or the attributes are never exported', () => {
    // `Span.end()` pushes the payload into the batch; attributes set afterwards
    // land on an object nothing reads again.
    const src = otel();
    const stamp = src.indexOf('stampIoAttribution(span, batch)');
    const end = src.indexOf('span.end();\n    batch.flush()');
    expect(stamp).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(end);
  });

  it('derives the split from the mirrored ledger, never an inline sum', () => {
    // Summing overlapping CLIENT spans double-counts concurrent queries and
    // drives self time negative — the bug io-ledger.ts exists to prevent, and
    // the reason the merge lives in a tested module rather than here.
    expect(otel()).toMatch(/import \{ attributeIoTime.*\} from '\.\/io-ledger\.ts'/);
  });

  it('feeds the ledger from the span KIND, so any outbound call counts', () => {
    // Hooked on `kind === CLIENT` in `end()` rather than inside TracedQuery, so
    // a hand-rolled CLIENT span around a `fetch` is attributed for free.
    const src = otel();
    expect(src).toMatch(/if \(this\.kind === SPAN_KIND_CLIENT\) \{\s*\n\s*this\.batch\.recordIo\(/);
  });

  it('keeps the ledger request-scoped by living on the ExportBatch', () => {
    // A background task's `detachedChild` gets its own batch, so work that
    // outlives the response cannot land on the request that spawned it.
    expect(otel()).toMatch(/recordIo\(interval: IoInterval\): void/);
  });
});

describe('OTLP metric export shares the trace exporter’s resource', () => {
  // Spans and metrics leaving the same isolate must describe the SAME resource,
  // or Dash0 files them under two services and they silently stop correlating.
  const metrics = () => read('supabase/functions/_shared/otlp-metrics.ts');

  it('imports the resource, endpoint and encoding from the span exporter', () => {
    const src = metrics();
    for (const symbol of ['buildResourceAttributes', 'getOtlpConfig', 'resolveServiceName', 'toOtlpValue']) {
      expect(src, `otlp-metrics.ts must reuse ${symbol}`).toContain(symbol);
    }
    expect(src).toMatch(/from '\.\/otel\.ts'/);
  });

  it('declares no service identity of its own', () => {
    // A second declaration is exactly how a metric ends up on a resource that
    // is not the spans' resource.
    const src = metrics();
    expect(src).not.toMatch(/'service\.name'/);
    expect(src).not.toMatch(/'service\.namespace'/);
  });

  it('posts metrics to /v1/metrics and spans to /v1/traces', () => {
    expect(metrics()).toMatch(/\/v1\/metrics/);
    expect(read('supabase/functions/_shared/otel.ts')).toMatch(/\/v1\/traces/);
  });

  it('emits CUMULATIVE monotonic sums, so the backend owns rate() and resets', () => {
    const src = metrics();
    expect(src).toMatch(/AGGREGATION_TEMPORALITY_CUMULATIVE = 2/);
    expect(src).toMatch(/isMonotonic: true/);
    // startTimeUnixNano carries the stats_reset, which is what lets a reset read
    // as a new series instead of as negative traffic.
    expect(src).toMatch(/startTimeUnixNano/);
  });

  it('renders int64 datapoints as JSON STRINGS, per proto3', () => {
    // A bare number here is the classic OTLP/JSON rejection — a silent 400.
    expect(metrics()).toMatch(/asInt: String\(/);
  });

  it('reports export failure instead of swallowing it', () => {
    // The span flush swallows, correctly: it is a side effect of serving a
    // request. Here the export IS the request, so a swallowed failure means a
    // cron job answering 200 while nothing reaches Dash0.
    const src = metrics();
    expect(src).toMatch(/exported: false/);
    expect(src).toMatch(/error: `OTLP metrics export failed/);
  });
});

describe('the profiling function is an operator surface, not a tenant one', () => {
  const profiling = () => read('supabase/functions/profiling/index.ts');

  it('refuses anything that is not the service-role key', () => {
    // pg_stat_statements aggregates query shapes across every caller, so a
    // read-capable tenant token (`lk_ro_*`) must not reach it either.
    expect(profiling()).toMatch(/resolved\.auth\.type !== 'service'/);
  });

  it('names its root span so faas.name derives to `profiling` for free', () => {
    expect(profiling()).toMatch(/traceRequest\(req, 'lorekit\.profiling'/);
  });

  it('maps rows through the mirrored pure module, not inline arithmetic', () => {
    // The ms→s conversion is the one unit change in the pipeline; it belongs
    // where vitest can see it.
    expect(profiling()).toMatch(/buildDbQueryMetrics/);
    expect(profiling()).not.toMatch(/\/ 1000/);
  });
});
