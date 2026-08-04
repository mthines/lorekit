import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Route-handler test for the token endpoint, following the
 * `api/auth/callback/route.spec.ts` pattern: mock the module the handler
 * imports, then dynamically import the route so the mock is in place.
 *
 * The properties under test are the ones a reviewer cannot verify by reading:
 * that every rejection collapses to one opaque `invalid_grant`, and that a
 * successful exchange never gets cached.
 */

const getClient = vi.fn();
const consumeAuthorizationCode = vi.fn();
const issueAccessToken = vi.fn();

vi.mock('@/lib/oauth/store', () => ({
  getClient: (...args: unknown[]) => getClient(...args),
  consumeAuthorizationCode: (...args: unknown[]) => consumeAuthorizationCode(...args),
  issueAccessToken: (...args: unknown[]) => issueAccessToken(...args),
}));

function tokenRequest(body: Record<string, string>): NextRequest {
  return new NextRequest('https://lorekit.io/api/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
}

const VALID_BODY = {
  grant_type: 'authorization_code',
  code: 'the-code',
  client_id: 'lkc_abc',
  redirect_uri: 'http://127.0.0.1:51703/callback',
  code_verifier: 'v'.repeat(43),
};

beforeEach(() => {
  vi.clearAllMocks();
  // The handler logs the internal rejection reason; silence it so the
  // rejection-collapsing cases below do not print a wall of expected warnings.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  getClient.mockResolvedValue({
    client_id: 'lkc_abc',
    client_name: 'Claude Code',
    redirect_uris: ['http://127.0.0.1:51703/callback'],
    grant_types: ['authorization_code'],
  });
});

describe('POST /api/oauth/token', () => {
  it('exchanges a valid code for a bearer token and forbids caching it', async () => {
    consumeAuthorizationCode.mockResolvedValue({
      ok: true,
      grant: {
        userId: 'user-1',
        clientId: 'lkc_abc',
        orgIds: ['org-a'],
        permissions: ['read', 'write'],
        scope: null,
      },
    });
    issueAccessToken.mockResolvedValue({
      accessToken: 'lk_rw_secret',
      expiresIn: 2_592_000,
      tokenId: 'tok-1',
    });

    const { POST } = await import('./route');
    const response = await POST(tokenRequest(VALID_BODY));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      access_token: 'lk_rw_secret',
      token_type: 'Bearer',
      expires_in: 2_592_000,
      scope: 'read write',
    });
  });

  it('rejects a non-authorization_code grant', async () => {
    const { POST } = await import('./route');
    const response = await POST(tokenRequest({ ...VALID_BODY, grant_type: 'client_credentials' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('requires a code_verifier — PKCE is mandatory', async () => {
    const { code_verifier: _omitted, ...withoutVerifier } = VALID_BODY;
    const { POST } = await import('./route');
    const response = await POST(tokenRequest(withoutVerifier));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_request' });
    expect(consumeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('answers 401 invalid_client for an unknown client_id', async () => {
    getClient.mockResolvedValue(null);
    const { POST } = await import('./route');
    const response = await POST(tokenRequest(VALID_BODY));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_client' });
  });

  it.each(['unknown_code', 'expired', 'replayed', 'redirect_mismatch', 'pkce_failed'] as const)(
    'collapses a %s rejection into one opaque invalid_grant',
    async (reason) => {
      // The anti-oracle property: an unauthenticated caller must not be able to
      // tell "expired" from "wrong verifier" from "never existed".
      consumeAuthorizationCode.mockResolvedValue({ ok: false, reason });
      const { POST } = await import('./route');
      const response = await POST(tokenRequest(VALID_BODY));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_grant');
      expect(body.error_description).toBe(
        'The authorization code is invalid, expired or already used.',
      );
    },
  );

  it('accepts a JSON body too — several MCP clients send one', async () => {
    consumeAuthorizationCode.mockResolvedValue({
      ok: true,
      grant: { userId: 'u', clientId: 'lkc_abc', orgIds: [], permissions: ['read'], scope: null },
    });
    issueAccessToken.mockResolvedValue({ accessToken: 'lk_ro_x', expiresIn: 60, tokenId: 't' });

    const { POST } = await import('./route');
    const response = await POST(
      new NextRequest('https://lorekit.io/api/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ scope: 'read' });
  });
});
