import { corsResponseHeaders, expandAllowedOrigins } from './cors-origins.ts';

const RAW = Deno.env.get('ALLOWED_ORIGINS') ?? '';
const IS_PROD = Deno.env.get('VERCEL_ENV') === 'production';
const CONFIGURED: string[] = RAW ? RAW.split(',').map((o) => o.trim()).filter(Boolean) : IS_PROD ? ['https://lorekit.io'] : ['*'];

// Admit BOTH the apex and the `www.` host for every configured origin — the
// dashboard is served from the canonical https://www.lorekit.io while the
// allowlist commonly names only the apex https://lorekit.io. See cors-origins.ts.
const ALLOWED: string[] = expandAllowedOrigins(CONFIGURED);

// The env read is all that is left here — the header decision itself (which
// origins get `Access-Control-Allow-Origin`, and the `*` fallback for a request
// that sends no Origin) lives in the mirrored pure `cors-origins.ts` so it has a
// vitest home; this file has none. See cors-origins.spec.ts in mcp-core.
export function corsHeaders(req: Request): Record<string, string> {
  return corsResponseHeaders(ALLOWED, req.headers.get('Origin') ?? '');
}

export function handlePreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
