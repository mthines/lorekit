import { NextResponse, type NextRequest } from 'next/server';
import { SupabaseAdminConfigError } from '@/lib/supabase/admin';
import { validateClientRegistration } from '@/lib/oauth/client-registration';
import { registerClient } from '@/lib/oauth/store';

/**
 * POST /api/oauth/register  (RFC 7591 — dynamic client registration)
 *
 * MCP hosts do not ship a pre-provisioned LoreKit client id. Claude Code,
 * Cursor and ChatGPT all discover the authorization server, register
 * themselves, and only then start the authorization-code flow — so without
 * this endpoint the "Authorize" button dead-ends before the user sees
 * anything.
 *
 * Registration is OPEN (no authentication). That is the RFC 7591 anonymous
 * profile and it is what makes discovery work at all; it is safe here because
 * a client id grants nothing on its own — every authorization still requires
 * an interactive, signed-in human to approve a consent screen, and every token
 * exchange still requires the PKCE verifier. The abuse ceiling is row
 * creation, which the redirect_uri allow-list and the bounded field lengths in
 * `validateClientRegistration` keep small.
 *
 * Returns 201 with the issued `client_id`. There is no `client_secret`:
 * LoreKit registers public clients only.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthError('invalid_client_metadata', 'Request body must be valid JSON.', 400);
  }

  const validated = validateClientRegistration(body);
  if (!validated.ok) {
    return oauthError(validated.error, validated.description, 400);
  }

  try {
    const client = await registerClient(validated.registration, null);
    return NextResponse.json(
      {
        client_id: client.client_id,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        // 0 = the registration does not expire (RFC 7591 §3.2.1).
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof SupabaseAdminConfigError) {
      console.error('[oauth/register] server misconfigured', error.missingEnv);
      return oauthError(
        'invalid_client_metadata',
        'Client registration is temporarily unavailable — the server is misconfigured.',
        503,
      );
    }
    console.error('[oauth/register] registration failed', (error as Error).message);
    return oauthError('invalid_client_metadata', 'Registration failed.', 500);
  }
}

/** Preflight — browser-based MCP clients register cross-origin. */
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

function oauthError(error: string, description: string, status: number) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } },
  );
}
