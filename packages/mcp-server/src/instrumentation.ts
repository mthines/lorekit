/**
 * OpenTelemetry SDK initialisation for LoreKit.
 * MUST be the first import in src/index.ts.
 *
 * Signals exported: traces, metrics, logs
 * Exporter: OTLP HTTP/protobuf → Dash0 (or any OTLP endpoint)
 *
 * Required env vars:
 *   OTEL_SERVICE_NAME            defaults to "lorekit"
 *   OTEL_TRACES_EXPORTER         set to "otlp" to enable
 *   OTEL_METRICS_EXPORTER        set to "otlp" to enable
 *   OTEL_LOGS_EXPORTER           set to "otlp" to enable
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. https://ingress.us-east-1.aws.dash0.com
 *   OTEL_EXPORTER_OTLP_HEADERS   e.g. Authorization=Bearer <DASH0_AUTH_TOKEN>
 *   OTEL_RESOURCE_ATTRIBUTES     e.g. deployment.environment.name=production
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { trace } from '@opentelemetry/api';

// Read service version from package.json at startup
const SERVICE_VERSION = process.env['npm_package_version'] ?? '0.0.1';
const SERVICE_NAME = process.env['OTEL_SERVICE_NAME'] ?? 'lorekit';

const resource = new Resource({
  [ATTR_SERVICE_NAME]: SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  // deployment.environment.name is set via OTEL_RESOURCE_ATTRIBUTES env var
  // per otel-instrumentation/rules/sdks/nodejs.md
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const metricReader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter(),
  exportIntervalMillis: 60_000,
}) as any;

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter(),
  metricReader,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy instrumentations not needed for this server
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
});

sdk.start();

/**
 * Flush all providers before process exit.
 * Per otel-instrumentation/rules/sdks/nodejs.md — prevents span loss on crash.
 */
type MaybeFlushable = { forceFlush?: () => Promise<void>; getDelegate?: () => unknown };

function forceFlushAll(): Promise<PromiseSettledResult<void>[]> {
  const promises: Promise<void>[] = [];
  let tp: unknown = trace.getTracerProvider();
  // Unwrap ProxyTracerProvider to reach NodeTracerProvider.forceFlush()
  const tpTyped = tp as MaybeFlushable;
  if (typeof tpTyped.forceFlush !== 'function' && typeof tpTyped.getDelegate === 'function') {
    tp = tpTyped.getDelegate();
  }
  const flusher = tp as MaybeFlushable;
  if (typeof flusher.forceFlush === 'function') {
    promises.push(flusher.forceFlush());
  }
  return Promise.allSettled(promises);
}

process.on('uncaughtException', (error) => {
  // Log to stderr; the pino logger may not be initialised yet at this point
  console.error(JSON.stringify({
    'exception.type': error.name,
    'exception.message': error.message,
    'exception.stacktrace': error.stack,
    msg: 'uncaught.exception',
  }));
  forceFlushAll().finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error(JSON.stringify({
    'exception.type': error.name,
    'exception.message': error.message,
    'exception.stacktrace': error.stack,
    msg: 'unhandled.rejection',
  }));
  forceFlushAll().finally(() => process.exit(1));
});

export { sdk };
