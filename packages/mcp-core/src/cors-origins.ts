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
export function isOriginAllowed(allowed: string[], origin: string): boolean {
  return allowed.includes('*') || allowed.includes(origin);
}
