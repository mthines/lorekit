/**
 * Next.js server-side instrumentation.
 * Next.js calls register() automatically on startup (App Router).
 * Uses @vercel/otel which wraps the OpenTelemetry Node SDK and works
 * seamlessly with Vercel's infrastructure.
 *
 * Required env vars (set in Vercel dashboard):
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://ingress.us-east-1.aws.dash0.com
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <DASH0_AUTH_TOKEN>
 *   OTEL_SERVICE_NAME              lorekit-web
 *   NEXT_PUBLIC_OTEL_SERVICE_VERSION  (injected by Vercel: VERCEL_GIT_COMMIT_SHA)
 */
import { registerOTel } from '@vercel/otel';

export function register() {
  registerOTel({
    serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'lorekit-web',
    attributes: {
      'service.version':
        process.env['VERCEL_GIT_COMMIT_SHA'] ??
        process.env['OTEL_SERVICE_VERSION'] ??
        'unknown',
      'deployment.environment.name':
        process.env['VERCEL_ENV'] ??
        process.env['NODE_ENV'] ??
        'development',
    },
  });
}
