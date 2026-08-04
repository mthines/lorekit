'use server';

/**
 * The consent decision.
 *
 * This is the ONLY place an authorization code is minted, and the only place
 * in the OAuth flow that runs under the user's browser session. It therefore
 * owns the two properties that make the whole flow safe:
 *
 *   1. The user id comes from `auth.getUser()` here — NEVER from a form field.
 *      A hidden `user_id` input would be an impersonation primitive.
 *   2. The org allow-list submitted by the browser is INTERSECTED with the
 *      caller's real memberships before it is stored. The checkbox list is a
 *      UI affordance, not an authority; a crafted POST naming someone else's
 *      org gets that org dropped, not granted.
 *
 * The redirect_uri is re-validated against the registered client rather than
 * trusted from the form, for the same reason: everything the browser sends
 * back is attacker-controllable in the general case.
 */

import { createServerClient } from '@/lib/supabase/server';
import { recordAuditEvent } from '@/lib/audit-log';
import { listMyOrgs } from '@/lib/orgs';
import type { TokenPermission } from '@/lib/tokens';
import { getClient, issueAuthorizationCode } from '@/lib/oauth/store';
import { buildRedirect, redirectUriMatches } from '@/lib/oauth/redirect-uri';
import { isValidCodeChallenge } from '@/lib/oauth/pkce';

export interface ConsentInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string | null;
  /** Org ids the user ticked. Intersected with real memberships below. */
  orgIds: string[];
  permissions: TokenPermission[];
}

export type ConsentResult = { redirectTo: string } | { error: string };

/** Approve the pending authorization request and mint a code. */
export async function approveAuthorization(input: ConsentInput): Promise<ConsentResult> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: 'Your session expired. Sign in and try again.' };

  const client = await getClient(input.clientId);
  if (!client) return { error: 'Unknown application. Restart the connection from your MCP client.' };

  if (!redirectUriMatches(input.redirectUri, client.redirect_uris)) {
    return { error: 'This application asked to be redirected somewhere it is not registered for.' };
  }
  if (!isValidCodeChallenge(input.codeChallenge)) {
    return { error: 'The application sent an invalid PKCE challenge.' };
  }

  // Authorization, not display: drop any org the user is not actually a
  // member of, whatever the form claimed.
  const memberships = await listMyOrgs();
  const memberOrgIds = new Set(memberships.map((org) => org.id));
  const orgIds = input.orgIds.filter((id) => memberOrgIds.has(id));

  const permissions = normalizePermissions(input.permissions);

  const code = await issueAuthorizationCode({
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    userId: user.id,
    orgIds,
    permissions,
    scope: input.scope,
  });

  // Reuses the existing api_key.create vocabulary rather than widening the
  // audit CHECK: what the user just authorized IS the creation of an API
  // credential, and `metadata.via` keeps the two populations separable.
  await recordAuditEvent({
    action: 'api_key.create',
    resourceType: 'api_token',
    target: client.client_name,
    metadata: {
      via: 'oauth',
      client_id: client.client_id,
      org_count: orgIds.length,
      permissions: permissions.join(','),
    },
  });

  return {
    redirectTo: buildRedirect(input.redirectUri, {
      code,
      state: input.state ?? undefined,
    }),
  };
}

/** Deny the request: redirect back with `access_denied` (RFC 6749 §4.1.2.1). */
export async function denyAuthorization(input: {
  clientId: string;
  redirectUri: string;
  state: string | null;
}): Promise<ConsentResult> {
  const client = await getClient(input.clientId);
  if (!client || !redirectUriMatches(input.redirectUri, client.redirect_uris)) {
    return { error: 'Unknown application.' };
  }
  return {
    redirectTo: buildRedirect(input.redirectUri, {
      error: 'access_denied',
      error_description: 'The user declined the authorization request.',
      state: input.state ?? undefined,
    }),
  };
}

/** A grant must carry at least one permission; default to read+write. */
function normalizePermissions(requested: TokenPermission[]): TokenPermission[] {
  const allowed = requested.filter((p): p is TokenPermission => p === 'read' || p === 'write');
  return allowed.length > 0 ? Array.from(new Set(allowed)) : ['read', 'write'];
}
