import { NextResponse, type NextRequest } from 'next/server';

/**
 * Same-origin request proxy for Scalar's "Send" / try-it-out on /api-docs.
 *
 * Scalar sends test requests to `proxyUrl?scalar_url=<encoded target>` using the
 * original method/headers/body. Because this route is same-origin with the docs
 * page, the browser applies NO CORS (and no preflight), so live testing works on
 * localhost, preview, and production without widening the Edge Function's CORS
 * allow-list. We forward the caller's pasted `Authorization` token as-is; we do
 * NOT inject any credential of our own.
 *
 * SSRF lock: the target MUST be the LoreKit REST API (`<SUPABASE_URL>/functions/
 * v1/...`). Anything else is rejected, so this can never be used as an open relay.
 * The page's own cookies (they arrive on this same-origin request) are NOT
 * forwarded upstream — only the header allow-list below is.
 */
const SUPABASE_URL =
  process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? 'https://pqokxlhvnosogizsjztg.supabase.co';
const API_ORIGIN = new URL(SUPABASE_URL).origin;
const API_PATH_PREFIX = '/functions/v1/';

// Only these request headers are relayed upstream. Notably excludes Cookie.
const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'traceparent', 'tracestate'];
// Hop-by-hop / encoding headers that must not be copied back verbatim.
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

function resolveTarget(req: NextRequest): URL | null {
  const raw = req.nextUrl.searchParams.get('scalar_url');
  if (!raw) return null;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return null;
  }
  // Must be exactly the LoreKit REST API — origin AND path prefix.
  if (target.origin !== API_ORIGIN || !target.pathname.startsWith(API_PATH_PREFIX)) return null;
  return target;
}

async function handle(req: NextRequest): Promise<Response> {
  const target = resolveTarget(req);
  if (!target) {
    return NextResponse.json(
      { error: 'Proxy target must be the LoreKit REST API.' },
      { status: 400 },
    );
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Scalar tunnels cookies through this header to dodge browser restrictions;
  // relay it as a real Cookie only when present (the LoreKit API is token-auth,
  // so this is effectively a no-op, but keeps the proxy protocol-faithful).
  const scalarCookie = req.headers.get('x-scalar-cookie');
  if (scalarCookie) headers.set('cookie', scalarCookie);

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: 'manual',
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const HEAD = handle;
