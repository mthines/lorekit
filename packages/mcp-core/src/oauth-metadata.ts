/**
 * OAuth protected-resource metadata for the MCP endpoint (RFC 9728).
 *
 * This is the RESOURCE server's half of MCP authorization. It answers one
 * question for a client that just got a 401: *which authorization server do I
 * go to?* Without it the host's "Authorize" button has nothing to point at and
 * the only way to attach a client stays "paste a token into a config file".
 *
 * The authorization server itself is the Next.js dashboard
 * (https://lorekit.io) — it already owns the Supabase-Auth session, the org
 * list the consent screen renders, and the api_tokens write path. The two live
 * on different origins, which RFC 9728 explicitly supports: the resource
 * advertises the AS, the AS advertises its own endpoints (RFC 8414).
 *
 * Import-free so it can be mirrored verbatim into
 * supabase/functions/mcp/oauth-metadata.ts (guarded by edge-parity.spec.ts) —
 * the auth-token.ts pattern. The web package keeps its own AS-metadata builder
 * in packages/web/src/lib/oauth/metadata.ts for the same reason web/lib/scope.ts
 * is a local copy: web must not depend on @lorekit/core. The two constants that
 * MUST agree across all three copies are asserted by oauth-metadata.spec.ts.
 */

/**
 * The MCP resource this metadata describes.
 *
 * Written as the concrete production URL, never a `<ref>` placeholder — the
 * hosted MCP server lives at a fixed Supabase project ref and this string is
 * user-facing (a client displays it during authorization).
 */
export const MCP_RESOURCE_URL = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

/** The authorization server that issues tokens for the resource above. */
export const AUTHORIZATION_SERVER_ISSUER = 'https://lorekit.io';

/** Scopes a token may carry. Mirrors api_tokens.permissions. */
export const OAUTH_SCOPES = ['read', 'write'];

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_documentation: string;
}

/** Build the RFC 9728 document served by the MCP endpoint. */
export function protectedResourceMetadata(
  resource: string = MCP_RESOURCE_URL,
  issuer: string = AUTHORIZATION_SERVER_ISSUER,
): ProtectedResourceMetadata {
  const base = issuer.replace(/\/+$/, '');
  return {
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: OAUTH_SCOPES.slice(),
    resource_documentation: base + '/docs/remote',
  };
}

/** Absolute URL of the protected-resource document for a given resource. */
export function protectedResourceMetadataUrl(resource: string = MCP_RESOURCE_URL): string {
  return resource.replace(/\/+$/, '') + '/.well-known/oauth-protected-resource';
}

/**
 * The `WWW-Authenticate` value returned with a 401 on a credential-less
 * request. This header IS the discovery trigger — an MCP client reads
 * `resource_metadata`, fetches it, finds the authorization server, and only
 * then can it offer the user an "Authorize" button.
 */
export function wwwAuthenticateChallenge(resource: string = MCP_RESOURCE_URL): string {
  return 'Bearer resource_metadata="' + protectedResourceMetadataUrl(resource) + '"';
}

/** True when the request path is asking for the protected-resource document. */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname.endsWith('/.well-known/oauth-protected-resource');
}
