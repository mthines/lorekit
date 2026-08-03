// CORS origin allowlist matching for the REST edge functions.
//
// Mirror of packages/mcp-core/src/cors-origins.ts, kept behaviourally identical
// and verbatim (the Deno edge function cannot cross-import the Node package).
// edge-parity.spec.ts asserts the two stay in sync; cors-origins.spec.ts in
// mcp-core is the shared test home.
//
// The dashboard's canonical Vercel domain is https://www.lorekit.io — the apex
// https://lorekit.io 308-redirects to it — but the `ALLOWED_ORIGINS` allowlist
// is commonly configured with the apex host alone. Admitting both the apex and
// the `www.` host makes the allowlist robust to whichever of the two is named.
// `*` passes through unchanged; a non-sibling origin is still rejected.
//
// Two classes of origin are ALWAYS admitted regardless of ALLOWED_ORIGINS, for the
// same reason (Bearer auth, not CORS, is the access control): loopback dev hosts,
// and the project's own Vercel deployments — including preview/branch hosts like
// `lorekit-git-<branch>-<scope>.vercel.app`, whose hostname is per-deployment and
// cannot be enumerated into a static allowlist. See isVercelPreviewOrigin.

// Expand a single configured origin to both its apex and its `www.` host.
export function expandOriginSiblings(origin: string): string[] {
  if (origin === '*') return ['*'];
  try {
    const url = new URL(origin);
    const apexHost = url.host.startsWith('www.') ? url.host.slice(4) : url.host;
    return [`${url.protocol}//${apexHost}`, `${url.protocol}//www.${apexHost}`];
  } catch {
    return [origin];
  }
}

// Build the effective allowlist from the configured origins, deduplicated.
export function expandAllowedOrigins(configured: string[]): string[] {
  return Array.from(new Set(configured.flatMap(expandOriginSiblings)));
}

// Whether a request Origin is permitted by an already-expanded allowlist.
//
// Loopback dev origins (localhost / 127.0.0.1 / [::1], any port or scheme) AND
// the project's own Vercel PREVIEW deployments are ALWAYS admitted, even when the
// origin is not in ALLOWED_ORIGINS. Safe: every request is authenticated with a
// Bearer token a cross-origin page cannot obtain, so CORS is not the access
// control here. See isLoopbackOrigin / isVercelPreviewOrigin for the host rules.
export function isOriginAllowed(allowed: string[], origin: string): boolean {
  return (
    allowed.includes('*') ||
    allowed.includes(origin) ||
    isLoopbackOrigin(origin) ||
    isVercelPreviewOrigin(origin)
  );
}

// True for a loopback dev origin. Matched on the EXACT host, so a lookalike such
// as `localhost.evil.com` is NOT loopback. The empty origin is never loopback.
function isLoopbackOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

// The Vercel project the dashboard deploys as, and the suffix Vercel serves every
// deployment of it under. Preview deployments get a per-branch / per-commit
// hostname — `lorekit-git-<branch>-<scope>.vercel.app`,
// `lorekit-<hash>-<scope>.vercel.app` — that can never be enumerated into a static
// allowlist, so they were CORS-blocked the moment the dashboard moved off the
// permissively-CORS'd PostgREST gateway onto these edge functions.
const VERCEL_APP_SUFFIX = '.vercel.app';
const VERCEL_PROJECT = 'lorekit';
const VERCEL_SCOPE = 'mads-thines-projects';

// True for one of the LoreKit project's own Vercel deployment origins — every
// generated preview/branch/production host Vercel serves the project under
// (`lorekit-git-<branch>-mads-thines-projects.vercel.app`,
// `lorekit-<hash>-mads-thines-projects.vercel.app`,
// `lorekit-mads-thines-projects.vercel.app`).
//
// The match is tied to BOTH halves of the deployment's identity: HTTPS only; the
// host must be a SINGLE DNS label before exactly `.vercel.app` (a label with a dot
// is rejected); and that label must start with the project name AND end with the
// Vercel ACCOUNT SCOPE slug. The scope suffix is what a third party cannot forge:
// anyone can create a project named `lorekit-x`, but its host ends with THEIR
// account scope, not `-mads-thines-projects`. `lorekit.io` and `lorekit.evil.com`
// are also rejected. Safe for the same reason loopback is (Bearer auth is the gate).
// If the project moves to a different Vercel account/team, update VERCEL_SCOPE.
function isVercelPreviewOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname;
    if (!host.endsWith(VERCEL_APP_SUFFIX)) return false;
    const label = host.slice(0, -VERCEL_APP_SUFFIX.length);
    if (label.includes('.')) return false;
    return label.startsWith(`${VERCEL_PROJECT}-`) && label.endsWith(`-${VERCEL_SCOPE}`);
  } catch {
    return false;
  }
}

// The origin-independent half of the CORS response. `Access-Control-Expose-Headers`
// is what lets a browser read the server span's `traceparent` off the response
// (traceRequest sets it) so client-side RUM can link to the server trace, plus the
// dry-run acknowledgement so a client can confirm no-op execution.
//
// `Vary: Origin` is mandatory here BECAUSE `Access-Control-Allow-Origin` is
// origin-dependent (echoed for an allowed origin, absent otherwise). Without it a
// shared/CDN cache keyed only on the URL could serve one origin's CORS response —
// including its `Access-Control-Allow-Origin` — to a different origin. It is emitted
// unconditionally, since the presence/absence of the ACAO header is itself a function
// of the request Origin even when the origin is disallowed.
const STATIC_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, traceparent, tracestate, X-LoreKit-Dry-Run, X-LoreKit-Client, X-LoreKit-Correlation-Id',
  'Access-Control-Expose-Headers': 'traceparent, X-LoreKit-Dry-Run',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

// Build the CORS response headers for one request Origin against an
// already-expanded allowlist.
//
// `Access-Control-Allow-Origin` is emitted ONLY when the origin is allowed. A
// disallowed origin gets NO such header rather than an empty one: the empty
// string is not a valid header value, and a browser reports that as a malformed
// response instead of a clean CORS rejection.
//
// A request that carries no Origin header at all (server-to-server, curl) falls
// back to `*` — reachable only when the allowlist itself is a wildcard, since
// `isOriginAllowed` rejects the empty origin otherwise — so the header is always
// a valid value whenever it is present.
export function corsResponseHeaders(allowed: string[], origin: string): Record<string, string> {
  const headers: Record<string, string> = { ...STATIC_CORS_HEADERS };
  if (isOriginAllowed(allowed, origin)) headers['Access-Control-Allow-Origin'] = origin || '*';
  return headers;
}
