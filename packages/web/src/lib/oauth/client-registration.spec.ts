import { describe, it, expect } from 'vitest';
import { MAX_REDIRECT_URIS, validateClientRegistration } from './client-registration';

function ok(body: unknown) {
  const result = validateClientRegistration(body);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.description}`);
  return result.registration;
}

describe('validateClientRegistration', () => {
  it('accepts a minimal MCP-host registration', () => {
    const registration = ok({
      client_name: 'Claude Code',
      redirect_uris: ['http://127.0.0.1:51703/callback'],
    });
    expect(registration.client_name).toBe('Claude Code');
    expect(registration.redirect_uris).toEqual(['http://127.0.0.1:51703/callback']);
    expect(registration.token_endpoint_auth_method).toBe('none');
    expect(registration.grant_types).toEqual(['authorization_code']);
  });

  it('defaults a missing client_name rather than rejecting', () => {
    // Anonymous DCR is the common path; a nameless client should still work,
    // it just gets a generic label on the consent screen.
    expect(ok({ redirect_uris: ['https://a.example/cb'] }).client_name).toBe('MCP client');
    expect(ok({ client_name: '   ', redirect_uris: ['https://a.example/cb'] }).client_name).toBe(
      'MCP client',
    );
  });

  it('de-duplicates redirect_uris so the allow-list cannot be padded', () => {
    const registration = ok({
      redirect_uris: ['https://a.example/cb', 'https://a.example/cb'],
    });
    expect(registration.redirect_uris).toEqual(['https://a.example/cb']);
  });

  it('rejects a non-object body', () => {
    expect(validateClientRegistration(null)).toMatchObject({ error: 'invalid_client_metadata' });
    expect(validateClientRegistration('nope')).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('requires at least one redirect_uri', () => {
    expect(validateClientRegistration({})).toMatchObject({ error: 'invalid_redirect_uri' });
    expect(validateClientRegistration({ redirect_uris: [] })).toMatchObject({
      error: 'invalid_redirect_uri',
    });
  });

  it('caps the number of redirect_uris', () => {
    const uris = Array.from({ length: MAX_REDIRECT_URIS + 1 }, (_, i) => `https://a.example/cb${i}`);
    expect(validateClientRegistration({ redirect_uris: uris })).toMatchObject({
      error: 'invalid_redirect_uri',
    });
  });

  it('rejects an insecure redirect_uri', () => {
    expect(validateClientRegistration({ redirect_uris: ['http://evil.com/cb'] })).toMatchObject({
      error: 'invalid_redirect_uri',
    });
  });

  it('rejects a non-string redirect_uri', () => {
    expect(validateClientRegistration({ redirect_uris: [42] })).toMatchObject({
      error: 'invalid_redirect_uri',
    });
  });

  it('refuses a confidential client instead of silently downgrading it', () => {
    // A client that believes it authenticated with a secret when it did not is
    // worse than one that got an honest error.
    expect(
      validateClientRegistration({
        redirect_uris: ['https://a.example/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    ).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('rejects an unsupported grant_type', () => {
    expect(
      validateClientRegistration({
        redirect_uris: ['https://a.example/cb'],
        grant_types: ['client_credentials'],
      }),
    ).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('rejects a non-code response_type', () => {
    expect(
      validateClientRegistration({
        redirect_uris: ['https://a.example/cb'],
        response_types: ['token'],
      }),
    ).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('truncates an over-long client_name instead of rejecting', () => {
    const registration = ok({
      client_name: 'x'.repeat(500),
      redirect_uris: ['https://a.example/cb'],
    });
    expect(registration.client_name).toHaveLength(200);
  });
});
