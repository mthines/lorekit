/**
 * Dynamic client registration (RFC 7591) request validation.
 *
 * Pure: takes the parsed JSON body, returns either a normalised registration
 * or a machine-readable rejection. The route handler owns persistence and
 * response shaping; everything that can be decided from the payload alone is
 * decided here so it can be unit-tested without a database.
 *
 * LoreKit registers PUBLIC clients only. An MCP host runs on the user's
 * machine and cannot keep a secret, so `token_endpoint_auth_method` is pinned
 * to `none` and PKCE carries the security. A registration asking for anything
 * else is rejected rather than silently downgraded — a client that believes it
 * authenticated with a secret when it did not is worse than one that got an
 * honest error.
 */

import { checkRedirectUri } from './redirect-uri';

/** Grant types LoreKit will register a client for. */
export const SUPPORTED_GRANT_TYPES = ['authorization_code'] as const;

export const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 200;

export interface ClientRegistration {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: 'none';
}

export type RegistrationResult =
  | { ok: true; registration: ClientRegistration }
  | { ok: false; error: 'invalid_client_metadata' | 'invalid_redirect_uri'; description: string };

export function validateClientRegistration(body: unknown): RegistrationResult {
  if (typeof body !== 'object' || body === null) {
    return reject('invalid_client_metadata', 'Request body must be a JSON object.');
  }
  const input = body as Record<string, unknown>;

  const rawUris = input['redirect_uris'];
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return reject('invalid_redirect_uri', 'redirect_uris must be a non-empty array.');
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    return reject('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed.`);
  }

  const redirect_uris: string[] = [];
  for (const candidate of rawUris) {
    if (typeof candidate !== 'string') {
      return reject('invalid_redirect_uri', 'Every redirect_uri must be a string.');
    }
    const verdict = checkRedirectUri(candidate);
    if (!verdict.ok) {
      return reject(
        'invalid_redirect_uri',
        `Rejected redirect_uri (${verdict.reason}). Allowed: https URLs, http loopback ` +
          '(127.0.0.1 / localhost / [::1]), or a dotted private-use scheme.',
      );
    }
    // De-duplicate so a client cannot pad the allow-list with repeats.
    if (!redirect_uris.includes(candidate)) redirect_uris.push(candidate);
  }

  const authMethod = input['token_endpoint_auth_method'] ?? 'none';
  if (authMethod !== 'none') {
    return reject(
      'invalid_client_metadata',
      'LoreKit registers public clients only; token_endpoint_auth_method must be "none".',
    );
  }

  const rawGrants = input['grant_types'] ?? [...SUPPORTED_GRANT_TYPES];
  if (!Array.isArray(rawGrants) || rawGrants.length === 0) {
    return reject('invalid_client_metadata', 'grant_types must be a non-empty array when present.');
  }
  const unsupported = rawGrants.find(
    (grant) => typeof grant !== 'string' || !SUPPORTED_GRANT_TYPES.includes(grant as never),
  );
  if (unsupported !== undefined) {
    return reject(
      'invalid_client_metadata',
      `Unsupported grant_type: ${String(unsupported)}. Supported: ${SUPPORTED_GRANT_TYPES.join(', ')}.`,
    );
  }

  const rawResponseTypes = input['response_types'];
  if (Array.isArray(rawResponseTypes) && !rawResponseTypes.every((t) => t === 'code')) {
    return reject('invalid_client_metadata', 'Only the "code" response_type is supported.');
  }

  const rawName = input['client_name'];
  const client_name =
    typeof rawName === 'string' && rawName.trim().length > 0
      ? rawName.trim().slice(0, MAX_CLIENT_NAME_LENGTH)
      : 'MCP client';

  return {
    ok: true,
    registration: {
      client_name,
      redirect_uris,
      grant_types: rawGrants as string[],
      token_endpoint_auth_method: 'none',
    },
  };
}

function reject(
  error: 'invalid_client_metadata' | 'invalid_redirect_uri',
  description: string,
): RegistrationResult {
  return { ok: false, error, description };
}
