/**
 * OAuth discovery metadata — BOTH documents, served from this app.
 *
 * The flow involves two documents that RFC 9728 / RFC 8414 imagine living on
 * two origins (the resource server and the authorization server). LoreKit
 * serves both from the dashboard:
 *
 *   * `/.well-known/oauth-protected-resource` (RFC 9728) — describes the MCP
 *     endpoint on *.supabase.co and names this app as its authorization
 *     server.
 *   * `/.well-known/oauth-authorization-server` (RFC 8414) — describes where
 *     /authorize, /token, /register and /revoke are.
 *
 * WHY BOTH LIVE HERE. RFC 9728 §3.1 lets the resource point at its metadata
 * with an absolute `resource_metadata` URL in `WWW-Authenticate`, and the MCP
 * spec requires clients to follow that value — so the document does not have
 * to be same-origin with the resource. Keeping it here buys one owner, one
 * pair of constants, and no pure module mirrored into the self-contained Deno
 * tree (which cannot import this package, so the alternative was a verbatim
 * copy plus an edge-parity entry for two string constants).
 *
 * The edge function still ANSWERS the same path — as a redirect here — so a
 * client that constructs the metadata URL from the resource identifier
 * (RFC 9728 §3.1's path-insertion form) instead of reading the header still
 * resolves. That redirect and the challenge string are the only OAuth
 * knowledge left in the edge tree, and `oauth-discovery.spec.ts` source-scans
 * both sides to keep them agreeing with this file.
 *
 * Pure: the issuer and the resource are arguments, not env reads, so a test
 * pins the whole document without stubbing `process.env`. The routes do the
 * env resolution and pass the values in.
 */

import { PRODUCTION_MCP_URL } from '@/lib/mcp-url';

/**
 * The MCP resource this authorization server issues tokens for.
 *
 * The DEFAULT only. The resource is a per-deployment fact — a preview stack
 * and a local stack each have their own MCP endpoint — so both builders below
 * take it as an argument and their routes pass `resolveMcpUrl()`
 * (`lib/mcp-url.ts`, the single derivation from `NEXT_PUBLIC_SUPABASE_URL`).
 * Hardcoding it here would make a preview deployment advertise production's
 * MCP server as its resource, and clients compare that value against the
 * server they are talking to.
 */
export const MCP_RESOURCE_URL = PRODUCTION_MCP_URL;

/** Canonical origin of the LoreKit authorization server (the dashboard). */
export const DEFAULT_ISSUER = 'https://lorekit.io';

/** Scopes the consent screen can grant. Mirrors `api_tokens.permissions`. */
export const SUPPORTED_SCOPES = ['read', 'write'] as const;

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
  service_documentation: string;
}

/** RFC 8414 — served at `<issuer>/.well-known/oauth-authorization-server`. */
export function authorizationServerMetadata(
  issuer: string = DEFAULT_ISSUER,
): AuthorizationServerMetadata {
  const base = issuer.replace(/\/+$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ['code'],
    // Only the authorization-code grant. Refresh tokens are deliberately not
    // advertised: the access token is long-lived (30 days) and a client that
    // hits expiry re-runs the same one-click authorize flow, which is a much
    // smaller surface than a second long-lived credential type.
    grant_types_supported: ['authorization_code'],
    // S256 only — OAuth 2.1 removes `plain`, and advertising it would invite a
    // downgrade we would then have to refuse at the token endpoint anyway.
    code_challenge_methods_supported: ['S256'],
    // Public clients only: there is no secret to present.
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SUPPORTED_SCOPES],
    service_documentation: `${base}/docs/remote`,
  };
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_documentation: string;
}

/**
 * RFC 9728 — describes the MCP endpoint and names its authorization server.
 *
 * `resource` is the MCP URL, not this app's origin: the document describes the
 * resource, wherever it is served from. A client compares this value against
 * the server it is talking to, so it must be THIS deployment's endpoint — the
 * route passes `resolveMcpUrl()` (`lib/mcp-url.ts`), which derives it from
 * `NEXT_PUBLIC_SUPABASE_URL`, so a preview stack advertises its own. The
 * `MCP_RESOURCE_URL` default above is what that derivation falls back to.
 *
 * Concrete either way: the derivation yields a real origin, never a `<ref>`
 * placeholder.
 */
export function protectedResourceMetadata(
  resource: string = MCP_RESOURCE_URL,
  issuer: string = DEFAULT_ISSUER,
): ProtectedResourceMetadata {
  const base = issuer.replace(/\/+$/, '');
  return {
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SUPPORTED_SCOPES],
    resource_documentation: `${base}/docs/remote`,
  };
}

/** Absolute URL of the protected-resource document. */
export function protectedResourceMetadataUrl(issuer: string = DEFAULT_ISSUER): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`;
}

/**
 * The `WWW-Authenticate` value the MCP endpoint returns on a credential-less
 * request. This header IS the discovery trigger — an MCP client reads
 * `resource_metadata`, fetches it, finds the authorization server, and only
 * then can it offer the user an "Authorize" button.
 *
 * Exported here as the single definition, and asserted against the literal the
 * Deno edge function emits by `oauth-discovery.spec.ts`.
 */
export function wwwAuthenticateChallenge(issuer: string = DEFAULT_ISSUER): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(issuer)}"`;
}
