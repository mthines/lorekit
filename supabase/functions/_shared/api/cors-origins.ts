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
