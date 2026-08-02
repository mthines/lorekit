import { NextResponse, type NextRequest } from 'next/server';
import { SupabaseAdminConfigError } from '@/lib/supabase/admin';
import { oauthErrorBody, oauthErrorStatus, type OAuthErrorCode } from '@/lib/oauth/errors';
import { consumeAuthorizationCode, getClient, issueAccessToken } from '@/lib/oauth/store';

/**
 * POST /api/oauth/token  (RFC 6749 §4.1.3, OAuth 2.1 profile)
 *
 * Exchanges a single-use authorization code + PKCE verifier for a LoreKit
 * access token. Called by the MCP client process directly — there is no
 * browser session, no cookie, and no client secret; the PKCE verifier is the
 * proof that the caller is the same party that started the flow.
 *
 * Every rejection is a flat `invalid_grant` with no detail. The distinctions
 * the store draws internally (expired vs. replayed vs. wrong redirect_uri) are
 * for telemetry: telling an unauthenticated caller which of those it hit turns
 * the endpoint into an oracle for probing codes.
 *
 * `application/x-www-form-urlencoded` per the RFC; JSON is also accepted
 * because several MCP clients send it and refusing would be pedantry that
 * breaks real users.
 */
export async function POST(request: NextRequest) {
  const params = await readParams(request);
  if (!params) {
    return tokenError('invalid_request', 'Unparseable request body.');
  }

  const grantType = params.get('grant_type');
  if (grantType !== 'authorization_code') {
    return tokenError(
      'unsupported_grant_type',
      `Unsupported grant_type "${grantType ?? ''}". Only authorization_code is supported.`,
    );
  }

  const code = params.get('code');
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const codeVerifier = params.get('code_verifier');

  if (!code || !clientId || !redirectUri) {
    return tokenError(
      'invalid_request',
      'code, client_id and redirect_uri are all required.',
    );
  }
  if (!codeVerifier) {
    // Called out explicitly rather than folded into invalid_grant: a client
    // that omits PKCE has a fixable bug, and this is not an oracle — it is
    // decided from the request alone, before any code lookup.
    return tokenError('invalid_request', 'code_verifier is required (PKCE is mandatory).');
  }

  try {
    const client = await getClient(clientId);
    if (!client) return tokenError('invalid_client', 'Unknown client_id.');

    const result = await consumeAuthorizationCode({
      code,
      clientId,
      redirectUri,
      codeVerifier,
    });

    if (!result.ok) {
      console.warn('[oauth/token] grant rejected', { client_id: clientId, reason: result.reason });
      return tokenError('invalid_grant', 'The authorization code is invalid, expired or already used.');
    }

    const issued = await issueAccessToken(result.grant, client.client_name);

    return NextResponse.json(
      {
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        scope: result.grant.permissions.join(' '),
      },
      {
        // RFC 6749 §5.1 — a token response must never be cached.
        headers: {
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  } catch (error) {
    if (error instanceof SupabaseAdminConfigError) {
      console.error('[oauth/token] server misconfigured', error.missingEnv);
      return tokenError('temporarily_unavailable', 'The authorization server is misconfigured.');
    }
    console.error('[oauth/token] exchange failed', (error as Error).message);
    return tokenError('server_error', 'Token exchange failed.');
  }
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

/** Read form-encoded (spec) or JSON (real-world) parameters. */
async function readParams(request: NextRequest): Promise<URLSearchParams | null> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') params.set(key, value);
      }
      return params;
    }
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

function tokenError(code: OAuthErrorCode, description: string) {
  return NextResponse.json(oauthErrorBody(code, description), {
    status: oauthErrorStatus(code),
    headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}
