/**
 * Correlated-trace emission harness (manual / on-demand — NOT part of CI).
 *
 * The unit suites that prove correlation (`otel-correlation.spec.ts`,
 * `otel-conventions.spec.ts`, `telemetry.test.mjs`) never boot an exporter, so
 * nothing they run shows up in Dash0 — correct for a fast, offline CI, but it
 * leaves no way to *visually* confirm cross-service correlation in the backend.
 * This harness fills that gap: it emits ONE real, correlated trace to Dash0 on
 * demand, covering the three production correlation paths —
 *
 *     cli ──▶ api (edge SERVER) ──▶ Postgres (edge CLIENT)      [CLI → api]
 *      └───▶ mcp-node (SERVER) ──▶ api (SERVER) ──▶ Postgres    [MCP → api + multi-hop]
 *
 * — as a single trace so the whole thing renders as one waterfall.
 *
 * Fidelity: every span is built with the component's OWN emission code, not a
 * re-implementation:
 *   • the `cli` span   → the CLI's real `buildTracePayload` (packages/cli)
 *   • the `api` spans  → the edge's real `Span` / `buildOtlpPayload`
 *     (supabase/functions/_shared/otel.ts)
 *   • the `mcp-node` span → the same edge builder with `service.name=mcp-node`
 *     (the Node MCP server emits via the OTel SDK, which can't be driven
 *     single-shot cross-package; the wire shape is identical)
 * Parent→child linkage is derived through the REAL W3C seam
 * (`formatTraceparent` → `parseTraceparent`, packages/mcp-core) exactly as the
 * edge's `extractTraceContext` does on the wire.
 *
 * Isolation: every span carries `deployment.environment.name=test` as a global
 * resource attribute, so these traces can be filtered/routed into a separate
 * Dash0 dataset and never pollute production telemetry.
 *
 * Config: reuses the CLI's own `resolveTelemetryConfig` — the exact
 * endpoint/token/dataset resolution the CLI ships (OTEL_EXPORTER_OTLP_ENDPOINT
 * + OTEL_EXPORTER_OTLP_HEADERS / LOREKIT_TELEMETRY_TOKEN, Dash0-Dataset). When
 * nothing is configured it no-ops with a clear message — never crashes, never
 * needs a committed secret.
 *
 * Run:  node --experimental-transform-types scripts/emit-correlated-trace.mts
 * See:  docs/telemetry-quality-review.md → "Emitting a real correlated trace".
 */

// The edge module (`_shared/otel.ts`) reads `Deno.env` when it builds a payload.
// Shim it onto Node's process.env so the edge's REAL code runs unmodified here.
// (Assigned before any harness call touches the edge builder.)
(globalThis as unknown as { Deno?: unknown }).Deno ??= {
  env: { get: (key: string) => process.env[key] },
};

import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { formatTraceparent, parseTraceparent } from '../packages/mcp-core/src/trace-context.ts';
import {
  Span,
  ExportBatch,
  buildOtlpPayload,
  SPAN_KIND_SERVER,
  SPAN_KIND_CLIENT,
} from '../supabase/functions/_shared/otel.ts';
import {
  resolveTelemetryConfig,
  buildTracePayload,
  randHex,
} from '../packages/cli/src/telemetry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The environment marker every harness span carries, so `test` is isolatable. */
export const HARNESS_ENVIRONMENT = 'test';

interface TraceCtx {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

/**
 * Continue a trace from a parent span, routing through the REAL W3C seam
 * (`formatTraceparent` → `parseTraceparent`) exactly as the edge's
 * `extractTraceContext` does when it receives an inbound request.
 */
function continueTrace(parentTraceId: string, parentSpanId: string, sampled: boolean): TraceCtx {
  const parsed = parseTraceparent(formatTraceparent(parentTraceId, parentSpanId, sampled));
  if (!parsed) throw new Error('harness: the traceparent seam produced an unparseable header');
  return {
    traceId: parsed.traceId,
    spanId: randHex(8),
    parentSpanId: parsed.parentSpanId,
    sampled: parsed.sampled,
  };
}

export interface CorrelatedTrace {
  traceId: string;
  /** One OTLP `/v1/traces` payload per service identity (cli, api, mcp-node). */
  payloads: { serviceName: string; payload: unknown }[];
}

/**
 * Build (but do not send) one correlated cross-service trace. Pure w.r.t. the
 * network — used both by `main()` and by the harness's own test. All spans
 * share one `trace_id`; every resource is stamped `deployment.environment.name`.
 */
export function buildCorrelatedTrace(
  { version = '0.0.0-harness', deploymentEnvironment = HARNESS_ENVIRONMENT }: { version?: string; deploymentEnvironment?: string } = {},
): CorrelatedTrace {
  const prevDeploy = process.env.DEPLOYMENT_ENVIRONMENT;
  const prevService = process.env.SERVICE_NAME;
  process.env.DEPLOYMENT_ENVIRONMENT = deploymentEnvironment;
  try {
    const traceId = randHex(16);
    const cliSpanId = randHex(8);
    const startMs = Date.now();

    // 1) CLI root span — the CLI's REAL OTLP builder (service.name = cli).
    const cliPayload = buildTracePayload({
      version,
      name: 'lorekit.cli.list',
      attributes: {
        'lorekit.cli.command': 'list',
        'lorekit.cli.outcome': 'ok',
        'lorekit.harness': true,
      },
      startMs,
      endMs: startMs + 40,
      status: 'ok',
      traceId,
      spanId: cliSpanId,
    });

    // 2) + 3) edge / mcp-node spans — the edge's REAL Span + buildOtlpPayload.
    const apiBatch = new ExportBatch();
    const mcpBatch = new ExportBatch();

    // CLI → api: a SERVER span continuing the CLI command span, then its DB call.
    const apiServer1 = new Span('lorekit.memories', continueTrace(traceId, cliSpanId, true), apiBatch, SPAN_KIND_SERVER);
    apiServer1.setAttributes({
      'http.request.method': 'POST',
      'url.path': '/memories',
      'faas.name': 'memories',
      'lorekit.tool.name': 'memory.write',
      'http.response.status_code': 200,
    });
    apiServer1
      .child('INSERT INTO memories (scope, key, value)', {
        'db.system': 'postgresql',
        'db.operation.name': 'INSERT',
        'db.collection.name': 'memories',
      }, SPAN_KIND_CLIENT)
      .end();
    apiServer1.end();

    // MCP → api: a mcp-node SERVER span continuing the trace, which then calls api.
    const mcpCtx = continueTrace(traceId, cliSpanId, true);
    const mcpServer = new Span('lorekit.mcp', mcpCtx, mcpBatch, SPAN_KIND_SERVER);
    mcpServer.setAttributes({
      'rpc.system': 'jsonrpc',
      'rpc.method': 'tools/call',
      'faas.name': 'mcp',
      'lorekit.tool.name': 'memory.read',
    });

    const apiServer2 = new Span('lorekit.memories', continueTrace(mcpCtx.traceId, mcpCtx.spanId, mcpCtx.sampled), apiBatch, SPAN_KIND_SERVER);
    apiServer2.setAttributes({
      'http.request.method': 'GET',
      'url.path': '/memories',
      'faas.name': 'memories',
      'lorekit.tool.name': 'memory.read',
      'http.response.status_code': 200,
    });
    apiServer2
      .child('SELECT scope, key, value FROM memories', {
        'db.system': 'postgresql',
        'db.operation.name': 'SELECT',
        'db.collection.name': 'memories',
      }, SPAN_KIND_CLIENT)
      .end();
    apiServer2.end();
    mcpServer.end();

    // Group by service.name (buildOtlpPayload reads SERVICE_NAME) so each hop
    // renders under its own service node in the map.
    process.env.SERVICE_NAME = 'api';
    const apiPayload = buildOtlpPayload(apiBatch.drain());
    process.env.SERVICE_NAME = 'mcp-node';
    const mcpPayload = buildOtlpPayload(mcpBatch.drain());

    return {
      traceId,
      payloads: [
        { serviceName: 'cli', payload: cliPayload },
        { serviceName: 'api', payload: apiPayload },
        { serviceName: 'mcp-node', payload: mcpPayload },
      ],
    };
  } finally {
    if (prevDeploy === undefined) delete process.env.DEPLOYMENT_ENVIRONMENT;
    else process.env.DEPLOYMENT_ENVIRONMENT = prevDeploy;
    if (prevService === undefined) delete process.env.SERVICE_NAME;
    else process.env.SERVICE_NAME = prevService;
  }
}

/** Resolve the CLI package version for a realistic `service.version`. */
function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(here, '../packages/cli/package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0-harness');
  } catch {
    return '0.0.0-harness';
  }
}

/** Read the Dash0 dataset from the resolved headers (case-insensitive). */
function datasetOf(headers: Record<string, string>): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'dash0-dataset');
  return key ? headers[key] : undefined;
}

async function postTraces(
  config: { endpoint: string; headers: Record<string, string> },
  payload: unknown,
  label: string,
): Promise<void> {
  const res = await fetch(`${config.endpoint}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...config.headers },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error(`[emit-correlated-trace] ${label}: OTLP export returned HTTP ${res.status} ${res.statusText}`);
  }
}

export async function main(): Promise<number> {
  const config = resolveTelemetryConfig();
  if (!config.enabled) {
    console.error(
      '[emit-correlated-trace] No OTLP endpoint/token configured — nothing emitted.\n' +
        'Set OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_HEADERS\n' +
        '(or LOREKIT_TELEMETRY_TOKEN for the baked-in endpoint), then re-run.',
    );
    return 0;
  }

  const deploymentEnvironment = process.env.DEPLOYMENT_ENVIRONMENT?.trim() || HARNESS_ENVIRONMENT;
  const { traceId, payloads } = buildCorrelatedTrace({ version: cliVersion(), deploymentEnvironment });

  for (const { serviceName, payload } of payloads) {
    await postTraces(config, payload, serviceName);
  }

  const host = (() => {
    try {
      return new URL(config.endpoint).host;
    } catch {
      return config.endpoint;
    }
  })();
  const dataset = datasetOf(config.headers) ?? '(default)';

  console.log('[emit-correlated-trace] Correlated trace emitted to Dash0.');
  console.log(`  trace_id   : ${traceId}`);
  console.log(`  services   : cli, api, mcp-node (${payloads.length} resource blocks)`);
  console.log(`  endpoint   : ${host}`);
  console.log(`  dataset    : ${dataset}`);
  console.log(`  filter in Dash0: deployment.environment.name = ${deploymentEnvironment}`);
  console.log(`  then open trace_id ${traceId} to see the CLI→api and MCP→api waterfall.`);
  return 0;
}

// Run only when invoked directly (never on import, e.g. from the test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[emit-correlated-trace] failed:', err);
      process.exit(1);
    });
}
