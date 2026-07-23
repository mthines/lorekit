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
 * VCS resource attributes (set via Vercel env vars — injected by CI):
 *   VERCEL_GIT_COMMIT_SHA          git commit SHA (Vercel-injected)
 *   VERCEL_GIT_COMMIT_REF          branch name (Vercel-injected)
 *   VERCEL_GIT_REPO_SLUG           owner/repo slug (Vercel-injected)
 *   VERCEL_GIT_REPO_OWNER          repo owner (Vercel-injected)
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

/**
 * Build vcs.* OTel resource attributes from Vercel-injected environment
 * variables. Vercel populates these automatically for every deployment —
 * no extra CI step required.
 *
 * Attributes are omitted when the corresponding env var is absent so the
 * resource never carries empty strings for VCS fields.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
 * @see https://vercel.com/docs/projects/environment-variables/system-environment-variables
 */
function buildVcsResourceAttributes(): Record<string, string> {
  const attrs: Record<string, string> = {};

  // Vercel injects VERCEL_GIT_COMMIT_SHA and VERCEL_GIT_COMMIT_REF for every
  // deployment. VERCEL_GIT_REPO_OWNER and VERCEL_GIT_REPO_SLUG provide the
  // repo identity without needing a separate secret.
  const owner = process.env['VERCEL_GIT_REPO_OWNER'];
  const slug = process.env['VERCEL_GIT_REPO_SLUG'];
  const refHeadName = process.env['VERCEL_GIT_COMMIT_REF'];
  const refHeadRevision = process.env['VERCEL_GIT_COMMIT_SHA'];

  if (owner && slug) {
    attrs['vcs.repository.url.full'] = `https://github.com/${owner}/${slug}`;
    attrs['vcs.repository.name'] = `${owner}/${slug}`;
  }
  if (refHeadName) {
    attrs['vcs.ref.head.name'] = refHeadName;
    // Vercel deploys are always from a branch (or a PR ref), never a tag.
    attrs['vcs.ref.head.type'] = 'branch';
  }
  if (refHeadRevision) {
    attrs['vcs.ref.head.revision'] = refHeadRevision;
  }

  return attrs;
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
      ...buildVcsResourceAttributes(),
    },
  });
}
