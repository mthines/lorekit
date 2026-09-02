import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { listMyOrgs } from '@/lib/orgs';
import { getClient } from '@/lib/oauth/store';
import { redirectUriMatches, buildRedirect } from '@/lib/oauth/redirect-uri';
import { isValidCodeChallenge, CODE_CHALLENGE_METHOD } from '@/lib/oauth/pkce';
import { AuthorizeConsent } from './AuthorizeConsent';
import { AuthorizeError } from './AuthorizeError';

export const metadata: Metadata = {
  title: 'Authorize application',
  // Never index a consent screen: the URL carries a client's PKCE challenge
  // and state, and a cached copy in a search index is a phishing template.
  robots: { index: false, follow: false },
};

/**
 * GET /oauth/authorize — the consent screen (RFC 6749 §4.1.1).
 *
 * Deliberately NOT under the `(dashboard)` route group: that layout renders the
 * whole sidebar/topbar shell, and a consent screen must be a focused,
 * unambiguous decision surface with nothing else competing for the click. It
 * does reuse the layout's auth gate verbatim — an unauthenticated visitor is
 * bounced to `/login?next=…` and lands back here after signing in, so the
 * existing Supabase cookie flow carries the whole login step.
 *
 * Error handling follows RFC 6749 §4.1.2.1 exactly: until `redirect_uri` has
 * been validated against a REGISTERED client, errors are rendered in the
 * browser. Redirecting before that point would make this an open redirector
 * that also hands the error to an attacker-chosen destination. After
 * validation, errors go back to the client where its code can see them.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const clientId = single(params['client_id']);
  const redirectUri = single(params['redirect_uri']);
  const responseType = single(params['response_type']);
  const codeChallenge = single(params['code_challenge']);
  const codeChallengeMethod = single(params['code_challenge_method']) ?? CODE_CHALLENGE_METHOD;
  const state = single(params['state']) ?? null;
  const scope = single(params['scope']) ?? null;

  // ── Phase 1: nothing may be redirected yet ─────────────────────────────
  if (!clientId) {
    return <AuthorizeError title="Missing client_id" detail="The request did not identify an application." />;
  }
  if (!redirectUri) {
    return <AuthorizeError title="Missing redirect_uri" detail="The request did not say where to send you back." />;
  }

  const client = await getClient(clientId);
  if (!client) {
    return (
      <AuthorizeError
        title="Unknown application"
        detail="This client is not registered with LoreKit. Reconnect the server from your MCP client so it can register itself."
      />
    );
  }
  if (!redirectUriMatches(redirectUri, client.redirect_uris)) {
    return (
      <AuthorizeError
        title="Redirect not allowed"
        detail={`${client.client_name} asked to be redirected to a URL it is not registered for. Nothing was authorized.`}
      />
    );
  }

  // ── Phase 2: redirect_uri is trusted — report errors to the client ─────
  if (responseType !== 'code') {
    redirect(
      buildRedirect(redirectUri, {
        error: 'unsupported_response_type',
        error_description: 'Only the authorization-code response type is supported.',
        state: state ?? undefined,
      }),
    );
  }
  if (codeChallengeMethod !== CODE_CHALLENGE_METHOD) {
    redirect(
      buildRedirect(redirectUri, {
        error: 'invalid_request',
        error_description: 'PKCE is mandatory and code_challenge_method must be S256.',
        state: state ?? undefined,
      }),
    );
  }
  if (!isValidCodeChallenge(codeChallenge)) {
    redirect(
      buildRedirect(redirectUri, {
        error: 'invalid_request',
        error_description: 'A valid S256 code_challenge is required.',
        state: state ?? undefined,
      }),
    );
  }

  // ── Phase 3: the user must be signed in to consent ─────────────────────
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    const query = new URLSearchParams();
    query.set('client_id', clientId);
    query.set('redirect_uri', redirectUri);
    query.set('response_type', 'code');
    query.set('code_challenge', codeChallenge as string);
    query.set('code_challenge_method', CODE_CHALLENGE_METHOD);
    if (state) query.set('state', state);
    if (scope) query.set('scope', scope);
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`);
  }

  const orgs = await listMyOrgs();

  return (
    <AuthorizeConsent
      clientName={client.client_name}
      clientId={clientId}
      redirectUri={redirectUri}
      codeChallenge={codeChallenge as string}
      state={state}
      scope={scope}
      userEmail={user?.email ?? null}
      orgs={orgs.map((org) => ({ id: org.id, name: org.name, slug: org.slug, role: org.role }))}
    />
  );
}

/** A repeated query parameter is a malformed request, not a list — take the first. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
