'use server';

/**
 * Server action to reveal the caller's Supabase session token (a JWT) so it can
 * be pasted into the API reference (`/api-docs`) to test the JWT-authenticated
 * endpoints — the Orgs/Members/Invites routes accept a Supabase session JWT,
 * not an `lk_*` API token.
 *
 * The JWT normally lives in an httpOnly cookie (not readable from client JS, to
 * blunt XSS token theft). This action is the deliberate, session-guarded seam
 * that hands it back on explicit user request. It is reveal-on-demand only —
 * nothing is exposed until the user clicks — and the UI masks it, shows the
 * expiry, and warns that it is a short-lived secret (see SessionTokenPanel).
 */

import { createServerClient } from '@/lib/supabase/server';
import { getVerifiedUser } from '@/lib/auth/verified-user';

export interface SessionToken {
  /** The Supabase access token (JWT). */
  token: string;
  /** Unix seconds at which the access token expires, when known. */
  expiresAt: number | null;
}

export async function getSessionToken(): Promise<SessionToken | null> {
  const supabase = await createServerClient();

  // Validate the session against the auth server first (getUser verifies the
  // JWT; getSession alone trusts the cookie), then read the access token to hand
  // back. No session → nothing to reveal. Routed through the request-cached
  // getVerifiedUser() (see lib/auth/verified-user.ts) so this doesn't pay a
  // second auth/v1/user round trip when another read on the same page already
  // resolved the session.
  const user = await getVerifiedUser();
  if (!user) return null;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  return { token: session.access_token, expiresAt: session.expires_at ?? null };
}
