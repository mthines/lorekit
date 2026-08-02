import { NextResponse } from 'next/server';
import { DEFAULT_ISSUER, protectedResourceMetadata } from '@/lib/oauth/metadata';

/**
 * GET /.well-known/oauth-protected-resource  (RFC 9728)
 *
 * Describes the MCP endpoint on *.supabase.co and names this app as its
 * authorization server. It is the FIRST document a client fetches after the
 * MCP endpoint answered a credential-less request with
 * `401 WWW-Authenticate: Bearer resource_metadata="<this URL>"`.
 *
 * Served from the dashboard rather than from the resource itself: RFC 9728
 * §3.1 lets the challenge carry an absolute metadata URL, and the MCP spec
 * requires clients to follow it, so co-location is not required — and keeping
 * it here means one owner for both discovery documents instead of a pure
 * module mirrored verbatim into the self-contained Deno tree. The edge
 * function still answers the equivalent path with a redirect here, for a
 * client that derives the URL from the resource identifier instead of reading
 * the header.
 *
 * Public, unauthenticated, and CORS-open: browser-based clients fetch it
 * cross-origin.
 */
export async function GET() {
  const issuer = process.env['NEXT_PUBLIC_APP_URL'] || DEFAULT_ISSUER;
  return NextResponse.json(protectedResourceMetadata(undefined, issuer), {
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
