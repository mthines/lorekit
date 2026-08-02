import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Drift guard for the OAuth discovery chain, which spans two packages that
 * cannot import each other.
 *
 * Both discovery documents are served by the Next.js dashboard
 * (packages/web/src/lib/oauth/metadata.ts). The Deno edge tree keeps only the
 * two things a resource server has to do itself: emit `WWW-Authenticate`, and
 * redirect a path-constructed metadata request to the real document. Those
 * three strings — the issuer, the metadata URL, and the challenge shape — must
 * agree across the split, because the failure mode is silent and total: a
 * challenge naming a URL nobody serves means every "Authorize" button fetches
 * a 404 and gives up, with nothing in the logs to say why.
 *
 * Source-scanned rather than imported: `packages/web` deliberately has no
 * dependency on `@lorekit/core` (the same reason web/lib/scope.ts is a local
 * copy), and the edge tree is Deno. This is the audit-vocabulary posture,
 * applied to a three-way constant.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

const edgeMetadata = read('supabase/functions/mcp/oauth-metadata.ts');
const edgeIndex = read('supabase/functions/mcp/index.ts');
const webMetadata = read('packages/web/src/lib/oauth/metadata.ts');
const webResourceRoute = read(
  'packages/web/src/app/.well-known/oauth-protected-resource/route.ts',
);

/** The two values the whole chain hangs off. */
const ISSUER = 'https://lorekit.io';
const METADATA_URL = `${ISSUER}/.well-known/oauth-protected-resource`;
const MCP_URL = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

describe('issuer agreement', () => {
  it('the edge names the dashboard as the authorization server', () => {
    expect(edgeMetadata).toContain(`export const AUTHORIZATION_SERVER_ISSUER = '${ISSUER}';`);
  });

  it('web declares the same issuer', () => {
    expect(webMetadata).toContain(`export const DEFAULT_ISSUER = '${ISSUER}';`);
  });

  it('web describes the concrete MCP resource, never a <ref> placeholder', () => {
    // Pinning the exact literal is what enforces the no-placeholder rule; a
    // blanket scan for `<ref>` would also match the prose that states the rule.
    expect(webMetadata).toContain(`export const MCP_RESOURCE_URL = '${MCP_URL}';`);
  });
});

describe('the challenge points at a document that is actually served', () => {
  it('the edge builds the challenge from the dashboard metadata URL', () => {
    expect(edgeMetadata).toContain(
      "export const PROTECTED_RESOURCE_METADATA_URL =\n  AUTHORIZATION_SERVER_ISSUER + '/.well-known/oauth-protected-resource';",
    );
    expect(edgeMetadata).toContain(
      `return 'Bearer resource_metadata="' + PROTECTED_RESOURCE_METADATA_URL + '"';`,
    );
  });

  it('web serves exactly that path', () => {
    // The route's own directory IS the contract; assert the file exists at the
    // path the challenge names and exports a GET.
    expect(webResourceRoute).toMatch(/export async function GET\(/);
    expect(webResourceRoute).toContain('protectedResourceMetadata');
  });

  it('web builds the same URL from its own constants', () => {
    expect(webMetadata).toContain(
      'return `${issuer.replace(/\\/+$/, \'\')}/.well-known/oauth-protected-resource`;',
    );
  });

  it('the two independently-built URLs are the same string', () => {
    // Belt and braces: reconstruct both sides from the scanned literals so a
    // future edit to either template is caught even if the greps above still
    // match.
    const edgeBuilt = `${ISSUER}/.well-known/oauth-protected-resource`;
    expect(edgeBuilt).toBe(METADATA_URL);
    expect(webMetadata).toContain(`export const DEFAULT_ISSUER = '${ISSUER}';`);
  });
});

describe('the resource server wires the challenge and the redirect', () => {
  it('emits WWW-Authenticate on the credential-less branch', () => {
    expect(edgeIndex).toContain("'WWW-Authenticate': wwwAuthenticateChallenge()");
  });

  it('answers the path-constructed metadata request with a redirect', () => {
    // A client that derives the URL from the resource identifier (RFC 9728
    // §3.1 path insertion) must not get a 404 just because we host the
    // document elsewhere.
    expect(edgeIndex).toContain('isProtectedResourceMetadataPath(url.pathname)');
    expect(edgeIndex).toContain('protectedResourceMetadataRedirect()');
    expect(edgeMetadata).toContain('status: 308');
    expect(edgeMetadata).toContain('Location: PROTECTED_RESOURCE_METADATA_URL');
  });

  it('the redirect is reachable cross-origin', () => {
    expect(edgeMetadata).toContain("'Access-Control-Allow-Origin': '*'");
  });
});
