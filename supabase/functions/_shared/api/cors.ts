const RAW = Deno.env.get('ALLOWED_ORIGINS') ?? '';
const IS_PROD = Deno.env.get('VERCEL_ENV') === 'production';
const ALLOWED: string[] = RAW ? RAW.split(',').map((o) => o.trim()).filter(Boolean) : IS_PROD ? ['https://lorekit.io'] : ['*'];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED.includes('*') || ALLOWED.includes(origin);
  return {
    'Access-Control-Allow-Origin': allow ? (origin || '*') : '',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, traceparent, tracestate',
    'Access-Control-Max-Age': '86400',
  };
}

export function handlePreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
