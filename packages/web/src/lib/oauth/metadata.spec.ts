import { describe, it, expect } from 'vitest';
import {
  authorizationServerMetadata,
  DEFAULT_ISSUER,
  MCP_RESOURCE_URL,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticateChallenge,
} from './metadata';

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

describe('protectedResourceMetadata', () => {
  it('describes the MCP endpoint and names this app as its authorization server', () => {
    const doc = protectedResourceMetadata();
    expect(doc.resource).toBe(MCP_RESOURCE_URL);
    expect(doc.authorization_servers).toEqual([DEFAULT_ISSUER]);
    expect(doc.bearer_methods_supported).toEqual(['header']);
    expect(doc.scopes_supported).toEqual(['read', 'write']);
  });

  it('keeps `resource` as the MCP URL even when served from another origin', () => {
    // The document describes the RESOURCE, not the host serving it. A client
    // compares this value against the server it is talking to, so substituting
    // the issuer here would fail every audience check.
    const doc = protectedResourceMetadata(undefined, 'https://preview.lorekit.io');
    expect(doc.resource).toBe(MCP_RESOURCE_URL);
    expect(doc.authorization_servers).toEqual(['https://preview.lorekit.io']);
  });

  it('returns a fresh scopes array so a caller cannot mutate the shared constant', () => {
    protectedResourceMetadata().scopes_supported.push('admin');
    expect(protectedResourceMetadata().scopes_supported).toEqual(['read', 'write']);
  });
});

describe('wwwAuthenticateChallenge', () => {
  it('points at the document the app actually serves', () => {
    // The whole discovery chain hangs off these two agreeing: the client parses
    // resource_metadata out of the header and fetches exactly that URL.
    expect(wwwAuthenticateChallenge()).toContain(protectedResourceMetadataUrl());
    expect(wwwAuthenticateChallenge()).toBe(
      `Bearer resource_metadata="${DEFAULT_ISSUER}/.well-known/oauth-protected-resource"`,
    );
  });

  it('normalises a trailing slash on the issuer', () => {
    expect(protectedResourceMetadataUrl('https://lorekit.io/')).toBe(
      'https://lorekit.io/.well-known/oauth-protected-resource',
    );
  });
});
