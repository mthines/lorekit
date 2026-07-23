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
