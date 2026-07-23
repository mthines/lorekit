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
 */
import { init, addSignalAttribute } from '@dash0/sdk-web';

const ENDPOINT = process.env['NEXT_PUBLIC_DASH0_OTLP_ENDPOINT'];
const AUTH_TOKEN = process.env['NEXT_PUBLIC_DASH0_AUTH_TOKEN'];

function resolveDeploymentEnv(): string {
  const env = process.env['NEXT_PUBLIC_VERCEL_ENV'];
  if (env === 'production') return 'production';
  if (env === 'preview') return 'preview';
  if (env === 'development') return 'development';
  return 'local';
}

if (ENDPOINT && AUTH_TOKEN) {
  init({
    serviceName: 'web',
    endpoint: { url: ENDPOINT, authToken: AUTH_TOKEN },
    additionalSignalAttributes: {
      'service.namespace': 'lorekit',
      'service.version': process.env['NEXT_PUBLIC_OTEL_SERVICE_VERSION'] ?? 'unknown',
      'deployment.environment.name': resolveDeploymentEnv(),
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
