import { NextResponse, type NextRequest } from 'next/server';
import { authorizationServerMetadata } from '@/lib/oauth/metadata';
import { issuerCacheControl, resolveIssuer } from '@/lib/oauth/issuer';

/**
 * GET /.well-known/oauth-authorization-server  (RFC 8414)
 *
 * The document an MCP client fetches after the resource server's 401 pointed
 * it here. It is what turns the host's "Authorize" button into a working flow:
 * without it the client knows there is an authorization server but not where
 * its /authorize and /token endpoints are.
 *
 * Public and unauthenticated by definition, and CORS-open because the fetch
 * frequently happens from a browser-based client on a different origin.
 *
 * The issuer is resolved per deployment (see lib/oauth/issuer.ts) — a preview
 * must advertise itself, not production. Caching follows that decision: a
 * request-derived origin is never cacheable.
 */
export async function GET(request: NextRequest) {
  const resolved = resolveIssuer(
    {
      vercelEnv: process.env['NEXT_PUBLIC_VERCEL_ENV'],
      appUrl: process.env['NEXT_PUBLIC_APP_URL'],
      vercelUrl: process.env['NEXT_PUBLIC_VERCEL_URL'],
    },
    request.nextUrl.origin,
  );

  return NextResponse.json(authorizationServerMetadata(resolved.issuer), {
    headers: {
      'Cache-Control': issuerCacheControl(resolved),
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/** Preflight for the cross-origin discovery fetch. */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
