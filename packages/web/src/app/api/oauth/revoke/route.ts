import { NextResponse, type NextRequest } from 'next/server';
import { SupabaseAdminConfigError } from '@/lib/supabase/admin';
import { revokeAccessToken } from '@/lib/oauth/store';

/**
 * POST /api/oauth/revoke  (RFC 7009)
 *
 * Lets an MCP client hand its token back when the user disconnects the server,
 * instead of leaving a live credential behind until it expires.
 *
 * ALWAYS answers 200, including for an unknown or already-revoked token —
 * RFC 7009 §2.2 requires it, and the reason is concrete: a 404 here would let
 * an unauthenticated caller enumerate which token values exist.
 *
 * Only `kind='oauth'` rows are revocable through this endpoint (see
 * `revokeAccessToken`). A personal `lk_*` token minted in the dashboard is
 * revoked in the dashboard; letting anyone who learns a token value delete it
 * over an unauthenticated endpoint is fine for a client's own OAuth
 * credential, but it should not be a second, quieter delete path for the
 * user's long-lived keys.
 */
export async function POST(request: NextRequest) {
  const token = await readToken(request);

  if (token) {
    try {
      await revokeAccessToken(token);
    } catch (error) {
      if (error instanceof SupabaseAdminConfigError) {
        console.error('[oauth/revoke] server misconfigured', error.missingEnv);
      } else {
        console.error('[oauth/revoke] revocation failed', (error as Error).message);
      }
      // Deliberately fall through to 200 — see the RFC note above. A failed
      // revocation is a server problem the client cannot act on, and reporting
      // it differently from "unknown token" reintroduces the oracle.
    }
  }

  return new NextResponse(null, {
    status: 200,
    headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

async function readToken(request: NextRequest): Promise<string | null> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { token?: unknown };
      return typeof body.token === 'string' ? body.token : null;
    }
    return new URLSearchParams(await request.text()).get('token');
  } catch {
    return null;
  }
}
