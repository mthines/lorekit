import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Disable Next.js's built-in ESLint step — NX runs it separately via nx lint
  eslint: { ignoreDuringBuilds: true },

  // Expose Supabase project ref to the browser so instrumentation-client.ts
  // can build the correct CORS URL pattern for W3C trace propagation headers.
  env: {
    NEXT_PUBLIC_SUPABASE_PROJECT_REF: process.env['NEXT_PUBLIC_SUPABASE_PROJECT_REF'] ?? '',
    // Vercel injects VERCEL_GIT_COMMIT_SHA server-side; expose to client for service.version
    NEXT_PUBLIC_OTEL_SERVICE_VERSION: process.env['VERCEL_GIT_COMMIT_SHA'] ?? 'unknown',
    // Vercel injects VERCEL_ENV = 'production' | 'preview' | 'development'.
    // Absent locally → map to 'local' in instrumentation-client.ts.
    NEXT_PUBLIC_VERCEL_ENV: process.env['VERCEL_ENV'] ?? '',
    // NEXT_PUBLIC_VERCEL_URL is the canonical origin used by LoginButton to build
    // the Supabase OAuth redirectTo. It must be a URL that Supabase's "Allow list"
    // recognises — so it must be a stable alias, never the per-deployment URL.
    //
    // Vercel exposes three relevant env vars (all server-side only):
    //   VERCEL_URL        — deployment-specific hostname, unique per build
    //                       (e.g. lorekit-3zw28wfrv-mads-thines-projects.vercel.app)
    //   VERCEL_BRANCH_URL — stable per-branch alias (preview only)
    //                       (e.g. lorekit-git-feat-ux-overhaul-mads-thines-projects.vercel.app)
    //   VERCEL_ENV        — 'production' | 'preview' | 'development'
    //
    // Strategy (in priority order):
    //   1. production  → NEXT_PUBLIC_APP_URL (the custom domain / stable alias)
    //   2. preview     → VERCEL_BRANCH_URL   (stable branch alias, constant for the branch's life)
    //   3. local dev   → '' (empty) so LoginButton falls back to window.location.origin,
    //                    picking up whatever port the dev server uses without hardcoding.
    //
    // Why NOT VERCEL_URL for previews: VERCEL_URL changes on every deployment.
    // If the user visits the branch alias (e.g. lorekit-git-feat-*) but the
    // OAuth redirectTo points at the deployment URL (lorekit-3zw28wfrv-*),
    // Supabase rejects the callback and the auth fails with "auth_failed".
    NEXT_PUBLIC_VERCEL_URL:
      process.env['VERCEL_ENV'] === 'production'
        ? (process.env['NEXT_PUBLIC_APP_URL'] ?? `https://${process.env['VERCEL_URL']}`)
        : process.env['VERCEL_ENV'] === 'preview'
          ? process.env['VERCEL_BRANCH_URL']
            ? `https://${process.env['VERCEL_BRANCH_URL']}`
            : `https://${process.env['VERCEL_URL']}`
          : '',

    // ── VCS resource attributes (OTel semantic conventions) ─────────────────
    // Vercel injects VERCEL_GIT_* system env vars into the build process.
    // We expose them as NEXT_PUBLIC_VCS_* so instrumentation-client.ts and
    // Dash0Provider can attach them to every browser span/log as resource
    // attributes, matching the server-side vcs.* attributes from instrumentation.ts.
    //
    // @see https://opentelemetry.io/docs/specs/semconv/registry/attributes/vcs/
    // @see https://vercel.com/docs/projects/environment-variables/system-environment-variables
    NEXT_PUBLIC_VCS_REPO_OWNER: process.env['VERCEL_GIT_REPO_OWNER'] ?? '',
    NEXT_PUBLIC_VCS_REPO_SLUG: process.env['VERCEL_GIT_REPO_SLUG'] ?? '',
    NEXT_PUBLIC_VCS_REF_HEAD_NAME: process.env['VERCEL_GIT_COMMIT_REF'] ?? '',
    NEXT_PUBLIC_VCS_REF_HEAD_REVISION: process.env['VERCEL_GIT_COMMIT_SHA'] ?? '',
  },

  // Allow Supabase + Dash0 to receive trace context headers from the browser.
  // Required for frontend → backend span correlation.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization, traceparent, tracestate',
          },
          {
            key: 'Access-Control-Expose-Headers',
            value: 'traceparent, tracestate',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
