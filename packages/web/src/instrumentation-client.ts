/**
 * Next.js client-side instrumentation hook (Next.js 15.3+).
 * Next.js loads this automatically in the browser before the app mounts.
 *
 * The Dash0 Web SDK is initialised here as a belt-and-suspenders backup
 * to the Dash0Provider React component (src/components/providers/Dash0Provider.tsx).
 * The component is the primary initialisation path; this file ensures the SDK
 * is ready even before React renders (e.g. for capturing early page-load spans).
 *
 * The `initialized` singleton guard in Dash0Provider prevents double-initialisation.
 *
 * VCS resource attributes are baked into the page at build time via next.config.ts
 * (NEXT_PUBLIC_VCS_* env vars). They are resolved from Vercel's system env vars
 * which are available to the build process.
 */
import { init, addSignalAttribute } from '@dash0/sdk-web';

const ENDPOINT = process.env['NEXT_PUBLIC_DASH0_OTLP_ENDPOINT'];
const AUTH_TOKEN = process.env['NEXT_PUBLIC_DASH0_AUTH_TOKEN'];

/**
 * Validates that the OTLP endpoint is an absolute HTTPS URL that is NOT
 * the same origin as the current page. This prevents a misconfigured env var
 * (e.g. NEXT_PUBLIC_DASH0_OTLP_ENDPOINT set to '/' or the Vercel deployment
 * URL) from causing the SDK to POST telemetry back to the app itself, which
 * would trigger CORS preflights against the app that fail with 400.
 */
function isValidOtlpEndpoint(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    // Must be an absolute HTTPS URL (or HTTP in local dev).
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    // Must not point back at the current page's origin.
    if (typeof window !== 'undefined' && parsed.origin === window.location.origin) {
      console.warn(
        '[Dash0] NEXT_PUBLIC_DASH0_OTLP_ENDPOINT points to the app origin — ' +
        'SDK initialisation skipped. Check Vercel env var configuration.',
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolveDeploymentEnv(): string {
  const env = process.env['NEXT_PUBLIC_VERCEL_ENV'];
  if (env === 'production') return 'production';
  if (env === 'preview') return 'preview';
  if (env === 'development') return 'development';
  return 'local';
}

/**
 * Build vcs.* OTel resource attributes from NEXT_PUBLIC_VCS_* env vars
 * that next.config.ts exposes from Vercel's system environment variables
 * (VERCEL_GIT_COMMIT_SHA, VERCEL_GIT_COMMIT_REF, VERCEL_GIT_REPO_OWNER,
 * VERCEL_GIT_REPO_SLUG). Attributes are omitted when absent.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
 */
function buildVcsSignalAttributes(): Record<string, string> {
  const attrs: Record<string, string> = {};

  const owner = process.env['NEXT_PUBLIC_VCS_REPO_OWNER'];
  const slug = process.env['NEXT_PUBLIC_VCS_REPO_SLUG'];
  const refHeadName = process.env['NEXT_PUBLIC_VCS_REF_HEAD_NAME'];
  const refHeadRevision = process.env['NEXT_PUBLIC_VCS_REF_HEAD_REVISION'];

  if (owner && slug) {
    attrs['vcs.repository.url.full'] = `https://github.com/${owner}/${slug}`;
    attrs['vcs.repository.name'] = `${owner}/${slug}`;
  }
  if (refHeadName) {
    attrs['vcs.ref.head.name'] = refHeadName;
    attrs['vcs.ref.head.type'] = 'branch';
  }
  if (refHeadRevision) {
    attrs['vcs.ref.head.revision'] = refHeadRevision;
  }

  return attrs;
}

if (isValidOtlpEndpoint(ENDPOINT) && AUTH_TOKEN) {
  init({
    serviceName: 'web',
    endpoint: { url: ENDPOINT, authToken: AUTH_TOKEN },
    additionalSignalAttributes: {
      'service.namespace': 'lorekit',
      'service.version': process.env['NEXT_PUBLIC_OTEL_SERVICE_VERSION'] ?? 'unknown',
      'deployment.environment.name': resolveDeploymentEnv(),
      ...buildVcsSignalAttributes(),
    },
    propagateTraceHeadersCorsURLs: [
      new RegExp(
        `https://${process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'] ?? '[^.]+'}\\.(supabase\\.co|supabase\\.in)/.*`,
      ),
    ],
  });

  addSignalAttribute('page.url.path', window.location.pathname);
}

export { addSignalAttribute };
