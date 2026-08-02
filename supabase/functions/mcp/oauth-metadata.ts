/**
 * The only OAuth knowledge in the edge tree.
 *
 * LoreKit's authorization server is the Next.js dashboard, and BOTH discovery
 * documents are served from there (see
 * packages/web/src/lib/oauth/metadata.ts for the reasoning). What has to live
 * here is the part only the resource server can do:
 *
 *   1. Emit `WWW-Authenticate` on a credential-less request. This header is
 *      the entire discovery trigger — without it an MCP client's "Authorize"
 *      button has nothing to point at.
 *   2. Answer the protected-resource path with a redirect to the real
 *      document, for a client that derives the metadata URL from the resource
 *      identifier (RFC 9728 §3.1's path-insertion form) rather than reading
 *      the absolute URL out of the header.
 *
 * This file is NOT a mirror of a mcp-core module — there is no pure logic to
 * share, only two constants. `packages/mcp-core/src/oauth-discovery.spec.ts`
 * source-scans this file and the web builder to assert they agree, which is
 * cheaper and more direct than an edge-parity entry over a copied module.
 */

/** Canonical origin of the LoreKit authorization server (the dashboard). */
export const AUTHORIZATION_SERVER_ISSUER = 'https://lorekit.io';

/**
 * The dashboard origin THIS deployment points clients at.
 *
 * Defaults to production, overridable with the `LOREKIT_APP_URL` secret. The
 * override is not a convenience: without it the staging Supabase project
 * challenges clients toward production `lorekit.io`, which would issue a token
 * for the wrong resource — and a local stack could not be authorized against
 * at all, so the flow would only ever be exercisable in production. This is
 * the "deploy tooling that legitimately targets multiple projects" carve-out
 * to the static-URL rule, not a placeholder in user-facing copy.
 */
export function authorizationServerIssuer(): string {
  const configured = Deno.env.get('LOREKIT_APP_URL');
  return (configured && configured.replace(/\/+$/, '')) || AUTHORIZATION_SERVER_ISSUER;
}

/** Absolute URL of the RFC 9728 document, served by the dashboard. */
export function protectedResourceMetadataUrl(): string {
  return authorizationServerIssuer() + '/.well-known/oauth-protected-resource';
}

/** The `WWW-Authenticate` value returned with a 401 on a credential-less request. */
export function wwwAuthenticateChallenge(): string {
  return 'Bearer resource_metadata="' + protectedResourceMetadataUrl() + '"';
}

/** True when the request path is asking for the protected-resource document. */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname.endsWith('/.well-known/oauth-protected-resource');
}

/**
 * Redirect a path-constructed metadata request to the document itself.
 *
 * 308 (permanent, method-preserving) rather than 302: the location is fixed
 * per deployment, and preserving the method keeps a client that probes with
 * something other than GET from silently switching verbs.
 */
export function protectedResourceMetadataRedirect(): Response {
  return new Response(null, {
    status: 308,
    headers: {
      Location: protectedResourceMetadataUrl(),
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
