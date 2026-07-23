/**
 * Next.js server-side instrumentation.
 * Next.js calls register() automatically on startup (App Router).
 * Uses @vercel/otel which wraps the OpenTelemetry Node SDK and works
 * seamlessly with Vercel's infrastructure.
 *
 * Required env vars (set in Vercel dashboard):
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://ingress.europe-west4.gcp.dash0-dev.com
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <DASH0_AUTH_TOKEN>
 *
 * deployment.environment.name values:
 *   'production'  — Vercel production (VERCEL_ENV=production)
 *   'preview'     — Vercel preview PR/branch (VERCEL_ENV=preview)
 *   'development' — `vercel dev` (VERCEL_ENV=development)
 *   'local'       — pure local dev (VERCEL_ENV absent)
 */
import { registerOTel } from '@vercel/otel';

function resolveDeploymentEnv(): string {
  const vercelEnv = process.env['VERCEL_ENV'];
  if (vercelEnv === 'production') return 'production';
  if (vercelEnv === 'preview') return 'preview';
  if (vercelEnv === 'development') return 'development';
  return 'local';
}

export function register() {
  registerOTel({
    serviceName: 'web',
    attributes: {
      'service.namespace': 'lorekit',
      'service.version':
        process.env['VERCEL_GIT_COMMIT_SHA'] ??
        process.env['OTEL_SERVICE_VERSION'] ??
        'unknown',
      'deployment.environment.name': resolveDeploymentEnv(),
    },
  });
}
