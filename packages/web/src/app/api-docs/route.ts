import { ApiReference } from '@scalar/nextjs-api-reference';

import { LOREKIT_SCALAR_CSS } from './theme';

/**
 * Public REST API reference — LoreKit's OpenAPI spec rendered with Scalar.
 *
 * This lives in the Next.js app rather than the Supabase `openapi` Edge
 * Function because Supabase forcibly sandboxes any HTML served from
 * `*.supabase.co` (it rewrites `text/html` → `text/plain` and injects a
 * `default-src 'none'; sandbox` CSP), so the old `GET /functions/v1/openapi/ui`
 * page could never render. On `lorekit.io` there is no such sandbox.
 *
 * The spec itself is still generated + served by the Edge Function; this page
 * just consumes it through the same-origin `/api-docs/spec` proxy (see the
 * sibling route) so the fetch works on localhost, preview, and production
 * regardless of the Edge Function's CORS allow-origin.
 */
const config = {
  url: '/api-docs/spec',
  pageTitle: 'LoreKit REST API',
  // Route "Send"/try-it-out through our same-origin forwarder so live testing
  // isn't blocked by the Edge Function's CORS allow-list (see ./proxy/route.ts).
  proxyUrl: '/api-docs/proxy',
  // LoreKit is a dark-only app, so pin the docs to dark and drop the toggle.
  theme: 'none' as const,
  darkMode: true,
  forceDarkModeState: 'dark' as const,
  hideDarkModeToggle: true,
  customCss: LOREKIT_SCALAR_CSS,
  // Enter the Bearer token ONCE and it applies to every operation (single
  // `BearerAuth` scheme). `persistAuth` keeps it in local storage so it also
  // survives page reloads — use a read-only `lk_ro_*` token to keep the blast
  // radius small, since local storage is readable by any script on the page.
  persistAuth: true,
  metaData: {
    title: 'LoreKit REST API',
    description: 'REST API reference for LoreKit — shared, persistent agent memory.',
  },
};

export const GET = ApiReference(config);
