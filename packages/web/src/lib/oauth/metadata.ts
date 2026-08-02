/**
 * Authorization-server metadata (RFC 8414).
 *
 * Two discovery documents exist and they are served by two different origins,
 * on purpose:
 *
 *   * The RESOURCE server (the MCP Edge Function on *.supabase.co) serves the
 *     RFC 9728 protected-resource document and emits the `WWW-Authenticate`
 *     header that points at it. That half lives in
 *     `packages/mcp-core/src/oauth-metadata.ts`, mirrored into
 *     `supabase/functions/mcp/oauth-metadata.ts`. It is deliberately NOT
 *     duplicated here — one owner per document.
 *
 *   * The AUTHORIZATION server (this Next.js app) serves the RFC 8414
 *     document below, describing where its /authorize, /token, /register and
 *     /revoke endpoints are.
 *
 * The two constants that must agree across the packages (the resource URL and
 * the issuer) are asserted by `packages/mcp-core/src/oauth-metadata.spec.ts`,
 * which source-scans this file — the same posture as the audit-vocabulary
 * guard, and the reason web can keep its own copy without depending on
 * `@lorekit/core`.
 *
 * Pure: the issuer is an argument, not an env read, so a test pins the whole
 * document without stubbing `process.env`.
 */

/** The MCP resource this authorization server issues tokens for. */
export const MCP_RESOURCE_URL = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

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
