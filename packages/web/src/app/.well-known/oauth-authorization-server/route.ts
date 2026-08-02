import { NextResponse } from 'next/server';
import { authorizationServerMetadata, DEFAULT_ISSUER } from '@/lib/oauth/metadata';

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
 * Cached at the edge — the contents change only when this code does.
 */
export async function GET() {
  const issuer = process.env['NEXT_PUBLIC_APP_URL'] || DEFAULT_ISSUER;
  return NextResponse.json(authorizationServerMetadata(issuer), {
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
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
