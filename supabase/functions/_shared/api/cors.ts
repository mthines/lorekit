const RAW = Deno.env.get('ALLOWED_ORIGINS') ?? '';
const IS_PROD = Deno.env.get('VERCEL_ENV') === 'production';
const CONFIGURED: string[] = RAW ? RAW.split(',').map((o) => o.trim()).filter(Boolean) : IS_PROD ? ['https://lorekit.io'] : ['*'];

// Expand every configured origin to BOTH its apex and its `www.` host. The
// dashboard's canonical Vercel domain is https://www.lorekit.io (the apex
// https://lorekit.io 308-redirects to it), but the allowlist is commonly set to
// the apex alone — so a browser preflight from the www host was blocked, with no
// Access-Control-Allow-Origin on the 204. The PostgREST gateway the dashboard
// used before the REST-client migration applied permissive CORS, which masked
// this mismatch until the dashboard started calling the edge functions directly.
// Accepting the sibling host makes the allowlist robust to which of the two is
// configured. `*` is passed through unchanged.
function expandOriginSiblings(origin: string): string[] {
  if (origin === '*') return ['*'];
  try {
    const url = new URL(origin);
    const apexHost = url.host.startsWith('www.') ? url.host.slice(4) : url.host;
    return [`${url.protocol}//${apexHost}`, `${url.protocol}//www.${apexHost}`];
  } catch {
    // Not a parseable origin (e.g. a bare wildcard variant) — keep it verbatim.
    return [origin];
  }
}

const ALLOWED: string[] = Array.from(new Set(CONFIGURED.flatMap(expandOriginSiblings)));

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED.includes('*') || ALLOWED.includes(origin);
  // Only emit Access-Control-Allow-Origin when the origin is allowed.
  // An empty string is not a valid header value and causes browser errors.
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, traceparent, tracestate, X-LoreKit-Dry-Run',
    // Lets a browser read the server span's traceparent off the response
    // (traceRequest sets it) so client-side RUM can link to the server trace,
    // plus the dry-run acknowledgement so a client can confirm no-op execution.
    'Access-Control-Expose-Headers': 'traceparent, X-LoreKit-Dry-Run',
    'Access-Control-Max-Age': '86400',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = origin || '*';
  return headers;
}

export function handlePreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
