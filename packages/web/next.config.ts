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
    // VERCEL_URL is the deployment-specific hostname (no protocol, no trailing slash).
    // It's unique per deployment — preview builds get the preview URL automatically.
    // Used by LoginButton to build the correct redirectTo for Supabase OAuth.
    //
    // IMPORTANT: On production deployments VERCEL_URL is the deployment-specific
    // URL (e.g. lorekit-abc123-mads-thines-projects.vercel.app), NOT the stable
    // alias (lorekit-io.vercel.app). Using the deployment URL as the OAuth
    // redirectTo causes Supabase to send the callback to the wrong origin, which
    // makes the auth code exchange fail with "auth_failed" on the first attempt
    // and lands the user on the preview deployment on the second attempt.
    //
    // Fix: prefer NEXT_PUBLIC_APP_URL on production so the redirectTo always
    // points at the stable alias. Only fall back to VERCEL_URL for preview /
    // development deployments where there is no stable alias.
    //
    // Local dev: VERCEL_URL is absent and we intentionally leave
    // NEXT_PUBLIC_VERCEL_URL empty so LoginButton falls back to
    // window.location.origin — this correctly picks up whatever port the dev
    // server is running on (3000, 3001, etc.) without hardcoding it here.
    NEXT_PUBLIC_VERCEL_URL:
      process.env['VERCEL_ENV'] === 'production'
        ? (process.env['NEXT_PUBLIC_APP_URL'] ?? `https://${process.env['VERCEL_URL']}`)
        : process.env['VERCEL_URL']
          ? `https://${process.env['VERCEL_URL']}`
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
