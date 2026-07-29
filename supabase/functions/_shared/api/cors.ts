/**
 * CORS headers for LoreKit REST Edge Functions.
 *
 * Allowed origins are read from the ALLOWED_ORIGINS environment variable
 * (comma-separated). Defaults allow the production dashboard and localhost
 * for development.
 *
 * Configure via Supabase secrets:
 *   supabase secrets set ALLOWED_ORIGINS="https://lorekit.io,https://app.lorekit.io"
 *
 * For development, `localhost` and `127.0.0.1` are always allowed.
 */

const ALWAYS_ALLOWED = ['http://localhost', 'http://127.0.0.1'];
const DEFAULT_ALLOWED = ['https://lorekit.io', 'https://app.lorekit.io'];

function getAllowedOrigins(): Set<string> {
  const raw = Deno.env.get('ALLOWED_ORIGINS');
  const configured = raw
    ? raw.split(',').map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ALLOWED;
  return new Set([...ALWAYS_ALLOWED, ...configured]);
}

/**
 * Returns CORS headers for the given request origin.
 * If the origin is in the allowed list, reflects it back; otherwise
 * returns the first configured allowed origin as a safe default.
 */
export function corsHeaders(requestOrigin?: string | null): Record<string, string> {
  const allowed = getAllowedOrigins();
  const origin = requestOrigin && allowed.has(requestOrigin)
    ? requestOrigin
    : DEFAULT_ALLOWED[0];

  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, traceparent, tracestate',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Handle a CORS preflight (OPTIONS) request.
 * Call this first in every Deno.serve handler.
 */
export function handlePreflight(req: Request): Response {
  const origin = req.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}
