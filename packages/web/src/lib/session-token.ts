'use server';

/**
 * Server action that hands the signed-in user their current Supabase session
 * JWT, so they can paste it into the /api-docs "Authorize" box to test the
 * JWT-only endpoints (Orgs / Members / Invites) — those reject `lk_*` API
 * tokens because they need `auth.uid()`.
 *
 * The JWT normally lives in an httpOnly cookie (unreadable from client JS), so
 * this is the only sanctioned way to obtain it. It is short-lived and scoped to
 * the caller's own data by RLS. Nothing is prefilled or auto-injected anywhere —
 * the token only ever leaves the server when the user explicitly asks for it.
 */

import { createServerClient } from '@/lib/supabase/server';
import { withSpan, SpanStatusCode } from '@/lib/telemetry';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

export interface SessionToken {
  /** The raw Supabase access token (JWT). */
  token: string;
  /** Unix epoch seconds when the token expires, if known. */
  expiresAt: number | null;
}

export async function getSessionToken(): Promise<SessionToken | { error: string }> {
  return withSpan('lorekit.session_token.reveal', {}, async (span) => {
    const supabase = await createServerClient();
    // getUser() validates against the auth server; getSession() then yields the
    // access token from the validated session.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ATTR_ERROR_TYPE, 'not_authenticated');
      return { error: 'Not signed in' };
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute(ATTR_ERROR_TYPE, 'no_active_session');
      return { error: 'No active session' };
    }
    return { token: session.access_token, expiresAt: session.expires_at ?? null };
  });
}
