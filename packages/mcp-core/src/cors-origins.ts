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
// Loopback dev origins (localhost / 127.0.0.1 / [::1], any port or scheme) are
// ALWAYS admitted so a dashboard running on a developer's machine can talk to the
// deployed edge functions without the loopback host being in ALLOWED_ORIGINS.
// This is safe: every request is authenticated with a Bearer token a cross-origin
// page cannot obtain, so CORS is not the access control here — it only decides
// which browser origin may read the response.
export function isOriginAllowed(allowed: string[], origin: string): boolean {
  return allowed.includes('*') || allowed.includes(origin) || isLoopbackOrigin(origin);
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
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, traceparent, tracestate, X-LoreKit-Dry-Run',
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
