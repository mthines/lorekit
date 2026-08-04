import type { NextConfig } from 'next';
// Relative import, not the `@/` alias: next.config.ts is loaded outside the
// app's module graph, so the tsconfig path mapping does not apply here.
import { resolveDeploymentId } from './src/lib/deployment-id';

const nextConfig: NextConfig = {
  // Disable Next.js's built-in ESLint step — NX runs it separately via nx lint
  eslint: { ignoreDuringBuilds: true },

  // Pin every asset URL and Server Action request to the deployment that built
  // the bundle making it (Vercel Skew Protection).
  //
  // Server Actions are a POST to the page route carrying a build-time action ID
  // (see src/middleware.ts). `deploy.yml` flips production with an alias swap on
  // every push to main, so a tab opened before the swap posts the OLD build's
  // action ID to the NEW deployment, which 404s it — the Overview's Accept /
  // Decline / onboarding buttons go silently dead until a hard reload.
  //
  // NOT active yet, and not active on today's production path: a deployment ID
  // is assigned at upload time, so `vercel build --prod` running inside GitHub
  // Actions (stage-web-production, then `vercel deploy --prebuilt`) never sees
  // VERCEL_DEPLOYMENT_ID. Activating this needs Skew Protection + system env
  // vars enabled on the project AND the production build moved onto Vercel's
  // builders. Until then this is `undefined` and nothing changes.
  // See src/lib/deployment-id.ts and docs/deployment.md for the full rationale.
  deploymentId: resolveDeploymentId(process.env),

  // `/settings/webhooks` was renamed to `/settings/integrations`. The old path
  // is in bookmarks, docs, and any link shared before the rename, so it
  // redirects rather than 404s.
  //
  // `/settings` has no content of its own — it lands on the first section.
  // That used to be a Server Component calling `redirect()`, which turned every
  // Settings click into a client-side redirect hop and crashed React inside
  // Next's app-router ("Minified React error #310"). Resolving it here means the
  // browser is redirected at the routing layer, before React renders anything.
  // Internal navigation targets `/settings/api-keys` directly (see
  // `src/lib/settings-routes.ts`), so this only catches bookmarks and external
  // links. Not permanent: `/settings` may grow a real landing page later, and a
  // 308 would be cached by browsers indefinitely.
  async redirects() {
    return [
      { source: '/settings/webhooks', destination: '/settings/integrations', permanent: true },
      { source: '/settings', destination: '/settings/api-keys', permanent: false },
    ];
  },

  // `@lorekit/schemas` is consumed as raw TS source (its `exports` point at
  // `.ts` files), so Next must transpile it. Used server-side by /api-docs/spec
  // to generate the OpenAPI document in-process.
  transpilePackages: ['@lorekit/schemas'],

  // Emit source maps in production so Dash0 can translate minified JavaScript
  // stack traces back to their original source locations. Source maps are served
  // alongside the JS bundles; Dash0 downloads them on demand when a browser.error
  // web event arrives. They are not loaded by end-user browsers unless DevTools
  // are open, so there is no runtime performance cost.
  // @see https://dash0.com/docs/dash0/monitoring/websites/resolve-stack-traces-with-source-maps
  productionBrowserSourceMaps: true,

  // Enable the React Compiler (babel-plugin-react-compiler) so components are
  // auto-memoized at build time — removes the need for most manual useMemo/
  // useCallback/React.memo. Requires the babel-plugin-react-compiler devDep.
  experimental: { reactCompiler: true },

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
    //
    // Both VERCEL_BRANCH_URL and VERCEL_URL are only populated by Vercel's own
    // cloud builds / at runtime — NOT during a manual `vercel build` in CI (the
    // /preview workflow's prebuilt path). When neither is present we must fall
    // back to '' so LoginButton uses window.location.origin (the actual host the
    // user is on, where the PKCE code-verifier cookie lives). Building
    // `https://${undefined}` here would bake a literal "https://undefined" into
    // the bundle, breaking the OAuth redirectTo and leaving the user logged out.
    NEXT_PUBLIC_VERCEL_URL:
      process.env['VERCEL_ENV'] === 'production'
        ? (process.env['NEXT_PUBLIC_APP_URL'] ?? `https://${process.env['VERCEL_URL']}`)
        : process.env['VERCEL_ENV'] === 'preview'
          ? process.env['VERCEL_BRANCH_URL']
            ? `https://${process.env['VERCEL_BRANCH_URL']}`
            : process.env['VERCEL_URL']
              ? `https://${process.env['VERCEL_URL']}`
              : ''
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
      // Serve Next.js static chunks with CORS headers so browsers can
      // attribute errors to the correct origin. Without these headers,
      // cross-origin script errors appear as opaque "Script error." at 0:0
      // (browser security policy strips the real message and stack for
      // cross-origin scripts loaded without crossorigin="anonymous" + CORS).
      // This affects iPhone Safari in particular, which does not cache
      // CORS-flagged resources as aggressively and re-fetches chunks on
      // navigation — surfacing the missing header on every page load.
      //
      // Setting Access-Control-Allow-Origin: * on static assets is safe:
      // these are public JS/CSS bundles with no cookies or credentials,
      // and the same-origin page already has full access to them.
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
      // Service worker must be served from the root scope with the correct
      // Content-Type and without a Cache-Control max-age so browsers can
      // detect updates promptly (spec: SW is revalidated every 24 h max, but
      // no-cache ensures the browser checks every navigation).
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      // Web app manifest
      {
        source: '/manifest.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json; charset=utf-8' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },
    ];
  },
};

export default nextConfig;
