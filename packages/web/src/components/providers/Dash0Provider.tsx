'use client';

/**
 * Dash0Provider — initialises the Dash0 Web SDK in the browser.
 *
 * Mount this in app/layout.tsx (root) so it runs on every page.
 * Using an explicit React component (vs relying solely on instrumentation-client.ts)
 * makes the SDK initialisation visible in the component tree, debuggable in
 * React DevTools, and works with every Next.js version.
 *
 * Also tracks client-side route changes so every navigation emits a page-view
 * span (mirrors the YouStory TrackPageUpdate pattern).
 *
 * VCS resource attributes are read from NEXT_PUBLIC_VCS_* env vars baked in at
 * build time via next.config.ts (sourced from Vercel system env vars).
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { init, addSignalAttribute, identify } from '@dash0/sdk-web';

const ENDPOINT = process.env['NEXT_PUBLIC_DASH0_OTLP_ENDPOINT'];
const AUTH_TOKEN = process.env['NEXT_PUBLIC_DASH0_AUTH_TOKEN'];

let initialized = false;

function resolveDeploymentEnv(): string {
  const env = process.env['NEXT_PUBLIC_VERCEL_ENV'];
  if (env === 'production') return 'production';
  if (env === 'preview') return 'preview';
  if (env === 'development') return 'development';
  return 'local';
}

/**
 * Build vcs.* OTel resource attributes from NEXT_PUBLIC_VCS_* env vars
 * baked in at build time (sourced from Vercel system env vars via next.config.ts).
 * Attributes are omitted when absent so no blank VCS fields pollute the resource.
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

function initDash0() {
  if (initialized || !ENDPOINT || !AUTH_TOKEN) return;
  initialized = true;

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
      // Propagate W3C trace context to Supabase — links browser spans to Edge Function spans
      new RegExp(
        `https://${process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'] ?? '[^.]+'}\\.(supabase\\.co|supabase\\.in)/.*`,
      ),
    ],
  });
}

interface Dash0ProviderProps {
  /** Authenticated user ID (opaque UUID). Pass from server after login. */
  userId?: string;
}

export function Dash0Provider({ userId }: Dash0ProviderProps) {
  const pathname = usePathname();
  const prevPathname = useRef<string | null>(null);

  // Initialise on first render
  useEffect(() => {
    initDash0();
  }, []);

  // Attach authenticated user ID to all subsequent telemetry
  useEffect(() => {
    if (userId && initialized) {
      identify(userId);
      addSignalAttribute('user.id', userId);
    }
  }, [userId]);

  // Emit a page-view event on every client-side navigation
  useEffect(() => {
    if (!initialized) return;
    if (prevPathname.current === pathname) return;
    prevPathname.current = pathname;

    // addSignalAttribute updates the attribute on all future spans/logs
    addSignalAttribute('page.url.path', pathname);
  }, [pathname]);

  return null;
}
