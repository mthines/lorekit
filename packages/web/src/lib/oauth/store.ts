/**
 * Persistence for the OAuth authorization-code flow.
 *
 * The impure shell around the pure modules in this directory. Every function
 * here uses the SERVICE-ROLE client (`createAdminClient`) because the caller is
 * an MCP client with no browser session and no cookie: the token, register and
 * revoke endpoints are reached by a CLI process, not by the user's browser.
 * RLS therefore cannot be the gate — authorization is the PKCE proof plus the
 * exact-match `client_id` / `redirect_uri` checks performed here.
 *
 * The one exception is the consent step: `issueAuthorizationCode` is called
 * from a server action that has already established the browser session and
 * passes the authenticated `userId` in. This module never derives an identity
 * of its own.
 *
 * NOT a `'use server'` module — these are ordinary server-side helpers, and
 * marking the file would force every export to become a callable action
 * endpoint, which is exactly what we do not want for `consumeAuthorizationCode`.
 */

import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { permissionSuffix } from '@/lib/token-permission';
import type { TokenPermission } from '@/lib/tokens';
import { randomToken, sha256Hex, verifyPkce } from './pkce';
import type { ClientRegistration } from './client-registration';

/**
 * Authorization codes are short-lived by design (RFC 6749 §4.1.2 recommends a
 * maximum of 10 minutes). The window only has to cover the browser redirect
 * back to a loopback listener, which is sub-second in practice.
 */
export const AUTHORIZATION_CODE_TTL_SECONDS = 600;

/**
 * Access-token lifetime. 30 days is the pragmatic middle: long enough that a
 * developer is not re-authorizing mid-sprint, short enough that a leaked token
 * has a bounded blast radius — which is the whole point of preferring this
 * flow over a never-expiring pasted token.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface OAuthClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
}

export interface AuthorizationGrant {
  userId: string;
  clientId: string;
  orgIds: string[];
  permissions: TokenPermission[];
  scope: string | null;
}

export type GrantResult =
  | { ok: true; grant: AuthorizationGrant }
  | { ok: false; reason: 'unknown_code' | 'expired' | 'replayed' | 'client_mismatch' | 'redirect_mismatch' | 'pkce_failed' };

/** Look up a registered client. Returns null when the id is unknown. */
export async function getClient(clientId: string): Promise<OAuthClientRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('oauth_clients')
    .select('client_id, client_name, redirect_uris, grant_types')
    .eq('client_id', clientId)
    .maybeSingle();
  return (data as OAuthClientRow | null) ?? null;
}

/** Persist a validated dynamic client registration and return the issued id. */
export async function registerClient(
  registration: ClientRegistration,
  createdBy: string | null,
): Promise<OAuthClientRow> {
  const admin = createAdminClient();
  // `lkc_` prefix so a client id is recognisable in logs and never mistaken
  // for an `lk_` credential.
  const clientId = `lkc_${randomToken(24)}`;
  const { data, error } = await admin
    .from('oauth_clients')
    .insert({
      client_id: clientId,
      client_name: registration.client_name,
      redirect_uris: registration.redirect_uris,
      grant_types: registration.grant_types,
      token_endpoint_auth_method: 'none',
      created_by: createdBy,
    })
    .select('client_id, client_name, redirect_uris, grant_types')
    .single();

  if (error) throw new Error(`oauth_client_insert_failed: ${error.message}`);
  return data as OAuthClientRow;
}

/**
 * Mint a single-use authorization code for an approved consent decision.
 *
 * Returns the PLAINTEXT code; only its SHA-256 is persisted, so a database read
 * cannot be replayed into a token.
 */
export async function issueAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  orgIds: string[];
  permissions: TokenPermission[];
  scope: string | null;
}): Promise<string> {
  const admin = createAdminClient();
  const code = randomToken(32);
  const codeHash = await sha256Hex(code);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString();

  const { error } = await admin.from('oauth_authorization_codes').insert({
    code_hash: codeHash,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    user_id: input.userId,
    org_ids: input.orgIds,
    permissions: input.permissions,
    scope: input.scope,
    expires_at: expiresAt,
  });

  if (error) throw new Error(`oauth_code_insert_failed: ${error.message}`);
  return code;
}

/**
 * Validate and consume an authorization code.
 *
 * Every failure returns the same shape so the caller can answer with one
 * `invalid_grant` — the reason is for telemetry, never for the response body,
 * because distinguishing "expired" from "wrong client" for an unauthenticated
 * caller is an oracle.
 *
 * A REPLAY (a code that was already consumed) is reported distinctly so the
 * caller can revoke the tokens minted from it: per OAuth 2.1 §4.1.3, a reused
 * code means the code leaked, and the credential derived from it must be
 * treated as compromised.
 */
export async function consumeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string | null;
}): Promise<GrantResult> {
  const admin = createAdminClient();
  const codeHash = await sha256Hex(input.code);

  const { data } = await admin
    .from('oauth_authorization_codes')
    .select('client_id, redirect_uri, code_challenge, code_challenge_method, user_id, org_ids, permissions, scope, expires_at, consumed_at')
    .eq('code_hash', codeHash)
    .maybeSingle();

  if (!data) return { ok: false, reason: 'unknown_code' };

  if (data.consumed_at) {
    // Replay. Burn every token this code produced — the code is in someone
    // else's hands and we cannot tell which exchange was the legitimate one.
    await admin
      .from('api_tokens')
      .delete()
      .eq('user_id', data.user_id as string)
      .eq('client_id', data.client_id as string)
      .eq('kind', 'oauth');
    return { ok: false, reason: 'replayed' };
  }

  if (new Date(data.expires_at as string).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (data.client_id !== input.clientId) return { ok: false, reason: 'client_mismatch' };
  if (data.redirect_uri !== input.redirectUri) return { ok: false, reason: 'redirect_mismatch' };

  const pkceOk = await verifyPkce(
    input.codeVerifier,
    data.code_challenge as string,
    data.code_challenge_method as string,
  );
  if (!pkceOk) return { ok: false, reason: 'pkce_failed' };

  // Mark consumed with a conditional update: `is('consumed_at', null)` makes
  // the burn atomic, so two concurrent exchanges of the same code cannot both
  // observe an unconsumed row and both mint a token.
  const { data: burned } = await admin
    .from('oauth_authorization_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code_hash', codeHash)
    .is('consumed_at', null)
    .select('code_hash');

  if (!burned || burned.length === 0) return { ok: false, reason: 'replayed' };

  return {
    ok: true,
    grant: {
      userId: data.user_id as string,
      clientId: data.client_id as string,
      orgIds: (data.org_ids as string[] | null) ?? [],
      permissions: (data.permissions as TokenPermission[] | null) ?? ['read', 'write'],
      scope: (data.scope as string | null) ?? null,
    },
  };
}

export interface IssuedToken {
  accessToken: string;
  expiresIn: number;
  tokenId: string;
}

/**
 * Random alphanumeric string of exactly `length` characters.
 *
 * Mirrors the private helper in `lib/tokens.ts`, which mints the dashboard's
 * tokens, so both paths produce the identical `lk_{rw|ro|wo}_<32>` shape. It is
 * copied rather than imported because `lib/tokens.ts` is a `'use server'`
 * module — exporting the helper there would turn it into a callable server
 * action endpoint.
 *
 * Base64url is deliberately NOT used here: `randomToken(24)` encodes to exactly
 * 32 characters, so stripping the two non-alphanumeric base64url symbols before
 * slicing yielded a suffix of variable length rather than a fixed 32.
 */
function randomAlphanumeric(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * Mint the access token for a redeemed grant.
 *
 * The token is an ordinary `api_tokens` row in the same `lk_{rw|ro|wo}_` format
 * the dashboard mints, so the three `resolveAuth` implementations, the
 * dashboard token list and the revoke path all keep working with no new code
 * path. What is new is `kind='oauth'`, an expiry, and the org allow-list.
 *
 * Re-authorizing the same client REPLACES its previous token. Without that, a
 * user who reconnects Claude Code a few times would silently consume their
 * 20-token cap with dead credentials.
 */
export async function issueAccessToken(
  grant: AuthorizationGrant,
  clientName: string,
): Promise<IssuedToken> {
  const admin = createAdminClient();

  await admin
    .from('api_tokens')
    .delete()
    .eq('user_id', grant.userId)
    .eq('client_id', grant.clientId)
    .eq('kind', 'oauth');

  const suffix = permissionSuffix(grant.permissions);
  const accessToken = `lk_${suffix}_${randomAlphanumeric(32)}`;
  const tokenHash = await sha256Hex(accessToken);
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();

  const { data, error } = await admin
    .from('api_tokens')
    .insert({
      user_id: grant.userId,
      name: clientName.slice(0, 100),
      token_prefix: `${accessToken.slice(0, 12)}...`,
      token_hash: tokenHash,
      permissions: grant.permissions,
      kind: 'oauth',
      client_id: grant.clientId,
      org_ids: grant.orgIds,
      expires_at: expiresAt,
    })
    .select('id')
    .single();

  if (error) throw new Error(`oauth_token_insert_failed: ${error.message}`);

  await admin
    .from('oauth_clients')
    .update({ last_used_at: new Date().toISOString() })
    .eq('client_id', grant.clientId);

  return {
    accessToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    tokenId: (data as { id: string }).id,
  };
}

/**
 * Revoke a token by its plaintext value (RFC 7009).
 *
 * Always reports success: §2.2 requires that an unknown token is answered with
 * 200, so a revocation endpoint cannot be used to probe which tokens exist.
 */
export async function revokeAccessToken(token: string): Promise<void> {
  const admin = createAdminClient();
  const tokenHash = await sha256Hex(token);
  await admin.from('api_tokens').delete().eq('token_hash', tokenHash).eq('kind', 'oauth');
}
