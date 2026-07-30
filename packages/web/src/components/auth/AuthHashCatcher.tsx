'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { fragmentCarriesAuthResult } from '@/lib/auth-callback-params';

/**
 * Rescues an implicit-flow auth result that landed on the wrong page.
 *
 * When a Supabase email link's `redirect_to` is not on the project's allow-list,
 * Supabase silently falls back to the **Site URL** — so the user ends up on
 * `/` (which forwards to `/login`) instead of `/api/auth/callback`, carrying
 * `#access_token=…` in the fragment. The server never sees a fragment, so the
 * callback route structurally cannot fix this; only a client component can.
 *
 * Mounted on the login page: if the URL fragment carries an auth result, send
 * the user to `/welcome`, which resolves the session and reports the outcome.
 * `router.replace` keeps the fragment (Next.js preserves it on a client-side
 * navigation), so supabase-js can still consume it there.
 *
 * Renders nothing, and does nothing at all on an ordinary visit.
 */
export function AuthHashCatcher() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!fragmentCarriesAuthResult(window.location.hash)) return;
    router.replace(`/welcome${window.location.hash}`);
  }, [router]);

  return null;
}
