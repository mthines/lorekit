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
    // Falls back to NEXT_PUBLIC_APP_URL (production) when not on Vercel.
    NEXT_PUBLIC_VERCEL_URL: process.env['VERCEL_URL']
      ? `https://${process.env['VERCEL_URL']}`
      : (process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3001'),
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
