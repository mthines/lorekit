const RAW = Deno.env.get('ALLOWED_ORIGINS') ?? '';
const IS_PROD = Deno.env.get('VERCEL_ENV') === 'production';
const ALLOWED: string[] = RAW ? RAW.split(',').map((o) => o.trim()).filter(Boolean) : IS_PROD ? ['https://lorekit.io'] : ['*'];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED.includes('*') || ALLOWED.includes(origin);
  // Only emit Access-Control-Allow-Origin when the origin is allowed.
  // An empty string is not a valid header value and causes browser errors.
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, traceparent, tracestate',
    // Lets a browser read the server span's traceparent off the response
    // (traceRequest sets it) so client-side RUM can link to the server trace.
    'Access-Control-Expose-Headers': 'traceparent',
    'Access-Control-Max-Age': '86400',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = origin || '*';
  return headers;
}

export function handlePreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
