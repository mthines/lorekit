// CORS origin allowlist matching for the REST edge functions.
//
// The dashboard's canonical Vercel domain is https://www.lorekit.io — the apex
// https://lorekit.io 308-redirects to it — but the `ALLOWED_ORIGINS` allowlist
// is commonly configured with the apex host alone. A browser preflight from the
// www host then comes back with no Access-Control-Allow-Origin and is blocked.
// (The PostgREST gateway the dashboard used before the REST-client migration
// applied permissive CORS, which masked the mismatch.)
//
// `expandAllowedOrigins` therefore admits BOTH the apex and the `www.` host for
// every configured origin, so the allowlist is robust to whichever of the two is
// named. `*` passes through unchanged; a non-sibling origin is still rejected.
//
// Two classes of origin are ALWAYS admitted regardless of ALLOWED_ORIGINS, for the
// same reason (Bearer auth, not CORS, is the access control): loopback dev hosts,
// and the project's own Vercel deployments — including preview/branch hosts like
// `lorekit-git-<branch>-<scope>.vercel.app`, whose hostname is per-deployment and
// cannot be enumerated into a static allowlist. See isVercelPreviewOrigin.
//
// `corsResponseHeaders` is the whole response-header decision that used to sit
// inline in the Deno-only `_shared/api/cors.ts`, lifted here for the same reason
// `rest-audit-actor.ts` and `rest-response-outcome.ts` were: the edge tree has no
// test harness, so a rule that is not in a mirrored pure module has no test home
// at all. `corsHeaders(req)` is now just the env read plus a call into this file.
//
// This module is pure and import-free so it can be mirrored verbatim into the
// Deno edge tree (supabase/functions/_shared/api/cors-origins.ts) — the edge
// function cannot cross-import this Node package. Keep the two copies
// behaviourally identical; edge-parity.spec.ts is the shared guard, and
// cors-origins.spec.ts exercises the logic here.

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
// origin is not in ALLOWED_ORIGINS. This is safe: every request is authenticated
// with a Bearer token a cross-origin page cannot obtain, so CORS is not the access
// control here — it only decides which browser origin may READ the response. A
// page that lacks the user's token learns nothing by being allowed to make the
// request. See isLoopbackOrigin / isVercelPreviewOrigin for the exact-host rules.
export function isOriginAllowed(allowed: string[], origin: string): boolean {
  return (
    allowed.includes('*') ||
    allowed.includes(origin) ||
    isLoopbackOrigin(origin) ||
    isVercelPreviewOrigin(origin)
  );
}

// True for a loopback dev origin. Matched on the EXACT host, so a lookalike such
// as `localhost.evil.com` (host `localhost.evil.com`, not `localhost`) is NOT
// loopback. The empty origin (a request with no Origin header) is never loopback.
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
// generated preview/branch/production host Vercel serves the project under:
//   lorekit-git-<branch>-mads-thines-projects.vercel.app
//   lorekit-<hash>-mads-thines-projects.vercel.app
//   lorekit-mads-thines-projects.vercel.app   (the <project>-<scope> alias)
//
// The match is tied to BOTH halves of the deployment's identity: HTTPS only; the
// host must be a SINGLE DNS label before exactly `.vercel.app` (a label with a dot
// — `lorekit-x.attacker.vercel.app` — is rejected); and that label must start with
// the project name AND end with the Vercel ACCOUNT SCOPE slug. The scope suffix is
// what a third party cannot forge: anyone can create a project named `lorekit-x`,
// but its generated host ends with THEIR account scope, not `-mads-thines-projects`
// — so `lorekit-x-someone-else.vercel.app`, `notlorekit-…`, `lorekit.io` and
// `lorekit.evil.com` are all rejected. Admitting the project's own preview fleet is
// safe for the same reason loopback is (Bearer auth, not CORS, is the gate).
//
// NOTE: if the project is moved to a different Vercel account/team, update
// VERCEL_SCOPE — a one-line change, same class as VERCEL_PROJECT.
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
