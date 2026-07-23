/**
 * Next.js server-side instrumentation.
 * Next.js calls register() automatically on startup (App Router).
 * Uses @vercel/otel which wraps the OpenTelemetry Node SDK and works
 * seamlessly with Vercel's infrastructure.
 *
 * Required env vars (set in Vercel dashboard):
 *   OTEL_EXPORTER_OTLP_ENDPOINT   https://ingress.europe-west4.gcp.dash0-dev.com
 *   OTEL_EXPORTER_OTLP_HEADERS    Authorization=Bearer <DASH0_AUTH_TOKEN>
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

export async function register() {
  // CRITICAL: guard on the nodejs runtime.
  // Next.js calls register() for BOTH the Node.js and Edge runtimes.
  // Without this guard @vercel/otel tries to initialise the Node SDK
  // in the Deno/Edge runtime, throws silently, and nothing is emitted.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

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
