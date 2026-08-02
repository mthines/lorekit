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
const mcpUrlLib = read('packages/web/src/lib/mcp-url.ts');
const webResourceRoute = read(
  'packages/web/src/app/.well-known/oauth-protected-resource/route.ts',
);

/** The two values the whole chain hangs off. */
const ISSUER = 'https://lorekit.io';
const METADATA_URL = `${ISSUER}/.well-known/oauth-protected-resource`;
const MCP_URL = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

describe('issuer agreement', () => {
  it('the edge defaults to the dashboard as the authorization server', () => {
    expect(edgeMetadata).toContain(`export const AUTHORIZATION_SERVER_ISSUER = '${ISSUER}';`);
  });

  it('web declares the same default issuer', () => {
    expect(webMetadata).toContain(`export const DEFAULT_ISSUER = '${ISSUER}';`);
  });

  it('the production MCP URL is declared once, as a concrete URL', () => {
    // Pinning the exact literal is what enforces the no-<ref>-placeholder
    // rule; a blanket scan for `<ref>` would also match the prose stating it.
    // It lives in mcp-url.ts because that is the ONE derivation of this
    // deployment's MCP endpoint — the OAuth document consumes it rather than
    // holding a second copy.
    expect(mcpUrlLib).toContain(`export const PRODUCTION_MCP_URL =\n  '${MCP_URL}';`);
    expect(webMetadata).toContain("import { PRODUCTION_MCP_URL } from '@/lib/mcp-url';");
    expect(webMetadata).toContain('export const MCP_RESOURCE_URL = PRODUCTION_MCP_URL;');
  });
});

describe('both sides are per-deployment, not pinned to production', () => {
  /**
   * The failure this prevents is quiet and bad: a staging Supabase project
   * challenging clients toward production `lorekit.io`, which then issues a
   * token for the wrong resource. It also makes the flow untestable anywhere
   * but production, which is how that bug would survive.
   */
  it('the edge issuer is overridable by LOREKIT_APP_URL', () => {
    expect(edgeMetadata).toContain("Deno.env.get('LOREKIT_APP_URL')");
    expect(edgeMetadata).toContain('export function authorizationServerIssuer()');
    // The challenge and the redirect must both go through it — a literal
    // baked into either one would silently re-pin that path to production.
    expect(edgeMetadata).toContain(
      "return 'Bearer resource_metadata=\"' + protectedResourceMetadataUrl() + '\"';",
    );
    expect(edgeMetadata).toContain('Location: protectedResourceMetadataUrl()');
  });

  it('the web resource document resolves the MCP URL per deployment', () => {
    expect(webResourceRoute).toContain("import { resolveMcpUrl } from '@/lib/mcp-url';");
    expect(webResourceRoute).toContain('protectedResourceMetadata(resolveMcpUrl(), issuer)');
    expect(webResourceRoute).toContain("process.env['NEXT_PUBLIC_APP_URL']");
  });
});

describe('the challenge points at a document that is actually served', () => {
  it('the edge builds the challenge from the dashboard metadata URL', () => {
    expect(edgeMetadata).toContain(
      "return authorizationServerIssuer() + '/.well-known/oauth-protected-resource';",
    );
    expect(edgeMetadata).toContain(
      `return 'Bearer resource_metadata="' + protectedResourceMetadataUrl() + '"';`,
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
    // Belt and braces: reconstruct each side from literals EXTRACTED FROM THAT
    // SIDE'S SOURCE, never from the local ISSUER const — two strings built
    // from one const are equal by construction and no source edit can break
    // them, so that form would assert nothing.
    const edgeIssuer = /export const AUTHORIZATION_SERVER_ISSUER = '([^']+)';/.exec(edgeMetadata);
    const edgePath = /return authorizationServerIssuer\(\) \+ '([^']+)';/.exec(edgeMetadata);
    const webIssuer = /export const DEFAULT_ISSUER = '([^']+)';/.exec(webMetadata);
    const webPath = /return `\$\{issuer\.replace\(\/\\\/\+\$\/, ''\)\}([^`]+)`;/.exec(webMetadata);

    // A regex that stops matching must fail loudly here; without these the
    // comparison below would collapse to undefined === undefined and pass.
    expect(edgeIssuer, 'edge issuer literal not found').not.toBeNull();
    expect(edgePath, 'edge metadata path literal not found').not.toBeNull();
    expect(webIssuer, 'web issuer literal not found').not.toBeNull();
    expect(webPath, 'web metadata path template not found').not.toBeNull();

    const edgeBuilt = `${edgeIssuer?.[1]}${edgePath?.[1]}`;
    const webBuilt = `${webIssuer?.[1]}${webPath?.[1]}`;

    expect(edgeBuilt).toBe(webBuilt);
    expect(edgeBuilt).toBe(METADATA_URL);
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
    expect(edgeMetadata).toContain('Location: protectedResourceMetadataUrl()');
  });

  it('the redirect is reachable cross-origin', () => {
    expect(edgeMetadata).toContain("'Access-Control-Allow-Origin': '*'");
  });
});
