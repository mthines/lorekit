import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  AUTHORIZATION_SERVER_ISSUER,
  MCP_RESOURCE_URL,
  isProtectedResourceMetadataPath,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticateChallenge,
} from './oauth-metadata';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

describe('protectedResourceMetadata', () => {
  it('names the MCP resource and points at the dashboard as the authorization server', () => {
    const doc = protectedResourceMetadata();
    expect(doc.resource).toBe(MCP_RESOURCE_URL);
    expect(doc.authorization_servers).toEqual([AUTHORIZATION_SERVER_ISSUER]);
    expect(doc.bearer_methods_supported).toEqual(['header']);
    expect(doc.scopes_supported).toEqual(['read', 'write']);
  });

  it('does not double a trailing slash on the issuer', () => {
    const doc = protectedResourceMetadata(MCP_RESOURCE_URL, 'https://lorekit.io/');
    expect(doc.authorization_servers).toEqual(['https://lorekit.io']);
    expect(doc.resource_documentation).toBe('https://lorekit.io/docs/remote');
  });

  it('returns a fresh scopes array so a caller cannot mutate the shared constant', () => {
    const first = protectedResourceMetadata();
    first.scopes_supported.push('admin');
    expect(protectedResourceMetadata().scopes_supported).toEqual(['read', 'write']);
  });
});

describe('wwwAuthenticateChallenge', () => {
  it('points at the document the resource server actually serves', () => {
    // The whole discovery chain hangs off these two agreeing: the client parses
    // resource_metadata out of the header and fetches exactly that URL.
    expect(wwwAuthenticateChallenge()).toContain(protectedResourceMetadataUrl());
    expect(wwwAuthenticateChallenge()).toBe(
      `Bearer resource_metadata="${MCP_RESOURCE_URL}/.well-known/oauth-protected-resource"`,
    );
  });

  it('is recognised by the router predicate it is paired with', () => {
    const url = new URL(protectedResourceMetadataUrl());
    expect(isProtectedResourceMetadataPath(url.pathname)).toBe(true);
  });

  it('does not match the plain MCP path', () => {
    expect(isProtectedResourceMetadataPath('/functions/v1/mcp')).toBe(false);
  });
});

describe('cross-package constant agreement', () => {
  /**
   * `packages/web` deliberately does not depend on `@lorekit/core` (the same
   * reason web/lib/scope.ts is a local copy), so the resource URL and issuer
   * exist in two places. They MUST agree: the resource server advertises an
   * authorization server that does not answer, or the authorization server
   * issues tokens for a resource nobody asked about, the moment they drift.
   * Source-scanned rather than imported — the audit-vocabulary posture.
   */
  const webMetadata = readFileSync(
    path.join(repoRoot, 'packages/web/src/lib/oauth/metadata.ts'),
    'utf8',
  );

  it('web declares the same MCP resource URL', () => {
    expect(webMetadata).toContain(`export const MCP_RESOURCE_URL = '${MCP_RESOURCE_URL}';`);
  });

  it('web declares the same issuer', () => {
    expect(webMetadata).toContain(`export const DEFAULT_ISSUER = '${AUTHORIZATION_SERVER_ISSUER}';`);
  });

  it('web advertises the endpoints this challenge sends clients to', () => {
    // The authorize endpoint is the one a human lands on; if it moves without
    // the page moving, every Authorize button 404s.
    expect(webMetadata).toContain('authorization_endpoint: `${base}/oauth/authorize`');
    expect(webMetadata).toContain('token_endpoint: `${base}/api/oauth/token`');
    expect(webMetadata).toContain('registration_endpoint: `${base}/api/oauth/register`');
  });
});
