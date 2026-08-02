import { describe, it, expect } from 'vitest';
import { authorizationServerMetadata, DEFAULT_ISSUER } from './metadata';

describe('authorizationServerMetadata', () => {
  it('advertises every endpoint the flow needs, rooted at the issuer', () => {
    const doc = authorizationServerMetadata();
    expect(doc.issuer).toBe(DEFAULT_ISSUER);
    expect(doc.authorization_endpoint).toBe(`${DEFAULT_ISSUER}/oauth/authorize`);
    expect(doc.token_endpoint).toBe(`${DEFAULT_ISSUER}/api/oauth/token`);
    expect(doc.registration_endpoint).toBe(`${DEFAULT_ISSUER}/api/oauth/register`);
    expect(doc.revocation_endpoint).toBe(`${DEFAULT_ISSUER}/api/oauth/revoke`);
  });

  it('advertises S256 only — never "plain"', () => {
    // Advertising `plain` would invite a downgrade the token endpoint refuses
    // anyway, turning a working client into a mysteriously failing one.
    expect(authorizationServerMetadata().code_challenge_methods_supported).toEqual(['S256']);
  });

  it('advertises public-client auth only', () => {
    expect(authorizationServerMetadata().token_endpoint_auth_methods_supported).toEqual(['none']);
  });

  it('advertises only the grant the token endpoint actually implements', () => {
    expect(authorizationServerMetadata().grant_types_supported).toEqual(['authorization_code']);
  });

  it('normalises a trailing slash on the issuer', () => {
    const doc = authorizationServerMetadata('https://preview.lorekit.io/');
    expect(doc.issuer).toBe('https://preview.lorekit.io');
    expect(doc.token_endpoint).toBe('https://preview.lorekit.io/api/oauth/token');
  });
});
