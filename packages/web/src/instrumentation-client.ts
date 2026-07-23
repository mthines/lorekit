/**
 * Next.js client-side instrumentation (browser RUM).
 * Next.js loads this file automatically in the browser via the
 * instrumentation-client convention (Next.js 15+).
 *
 * Uses @dash0/sdk-web for Real User Monitoring:
 * - Page loads, navigation, Web Vitals
 * - Fetch request tracing (with W3C trace-context propagation to the API)
 * - Uncaught errors and promise rejections
 * - Session and user tracking
 *
 * Required env vars (NEXT_PUBLIC_ — inlined at build time, visible in browser):
 *   NEXT_PUBLIC_DASH0_OTLP_ENDPOINT   e.g. https://ingress.us-east-1.aws.dash0.com
 *   NEXT_PUBLIC_DASH0_AUTH_TOKEN      ingesting-only token (separate from server token)
 *
 * Security: use a dedicated auth token with:
 *   - Role: Ingesting only
 *   - Dataset: lorekit (scoped to your dataset)
 *   This token is public — it will appear in the JS bundle.
 */
import { init, addSignalAttribute, identify } from '@dash0/sdk-web';

const ENDPOINT = process.env['NEXT_PUBLIC_DASH0_OTLP_ENDPOINT'];
const AUTH_TOKEN = process.env['NEXT_PUBLIC_DASH0_AUTH_TOKEN'];

/**
 * Resolve the deployment environment name.
 * VERCEL_ENV is injected by Vercel and exposed via next.config.ts:
 *   'production'  → Vercel production deployment
 *   'preview'     → Vercel preview deployment (PR, branch)
 *   'development' → `vercel dev` locally
 *   ''            → pure local dev (no Vercel CLI) → mapped to 'local'
 */
function resolveDeploymentEnv(): string {
  const vercelEnv = process.env['NEXT_PUBLIC_VERCEL_ENV'];
  if (vercelEnv === 'production') return 'production';
  if (vercelEnv === 'preview') return 'preview';
  if (vercelEnv === 'development') return 'development';
  return 'local';
}

// Only initialise if the endpoint is configured — gracefully no-ops in dev
// without breaking the app.
if (ENDPOINT && AUTH_TOKEN) {
  init({
    serviceName: 'web',
    endpoint: {
      url: ENDPOINT,
      authToken: AUTH_TOKEN,
    },
    // service.namespace groups this signal alongside the mcp and health
    // functions under the "lorekit" namespace in Dash0.
    additionalSignalAttributes: {
      'service.namespace': 'lorekit',
      'service.version': process.env['NEXT_PUBLIC_OTEL_SERVICE_VERSION'] ?? 'unknown',
      'deployment.environment.name': resolveDeploymentEnv(),
    },
    // Propagate W3C trace context to Supabase API calls so server spans
    // are linked to the browser span that initiated them.
    propagateTraceHeadersCorsURLs: [
      // Supabase project API (memory reads, auth)
      new RegExp(`https://${process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'] ?? '[^.]+'}\\.(supabase\\.co|supabase\\.in)/.*`),
    ],
  });
}

/**
 * Call this after the user logs in via Supabase to attach their ID
 * to all subsequent RUM telemetry. Opaque ID only — never email or name.
 */
export function identifyUser(userId: string) {
  if (ENDPOINT && AUTH_TOKEN) {
    // identify() attaches the opaque user ID to all subsequent RUM telemetry.
    // Per otel-semantic-conventions: pass only an opaque ID, never email/name.
    identify(userId);
    addSignalAttribute('user.id', userId);
  }
}

export { addSignalAttribute };
