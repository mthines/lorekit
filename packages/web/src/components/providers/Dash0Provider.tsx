'use client';

/**
 * Dash0Provider — attaches identity to browser RUM.
 *
 * The SDK itself is initialised by `lib/dash0-rum.ts`, which
 * `instrumentation-client.ts` calls before React mounts. This component calls
 * the same idempotent initialiser (so the SDK is up even if the Next.js hook
 * did not run) and then owns the one thing that needs the React tree: upgrading
 * the anonymous visitor id to the authenticated user id.
 *
 * The route needs no handling here: the SDK derives `page.url.path` from
 * `window.location.href` on every signal it emits.
 *
 * Mount it in the ROOT layout so public pages — marketing, `/docs`, `/login` —
 * are identified too, and pass `userId` from the authenticated layout. It is
 * safe to mount twice: initialisation is guarded, and only the mount that was
 * given a `userId` ever touches the identity.
 *
 * VCS resource attributes are read from NEXT_PUBLIC_VCS_* env vars baked in at
 * build time via next.config.ts (sourced from Vercel system env vars).
 */

import { useEffect } from 'react';

import { initDash0Rum, identifyDash0User } from '@/lib/dash0-rum';

interface Dash0ProviderProps {
  /**
   * Authenticated user ID (opaque UUID). Pass from the server after login.
   * Omitted on public pages, where the visitor keeps the anonymous id
   * `initDash0Rum` assigned.
   */
  userId?: string;
}

export function Dash0Provider({ userId }: Dash0ProviderProps) {
  // Initialise on first render. Idempotent — `instrumentation-client.ts` has
  // normally done this already.
  useEffect(() => {
    initDash0Rum();
  }, []);

  // Attach the authenticated user ID to all subsequent telemetry, replacing the
  // anonymous id. Runs after the init effect above, so the SDK is always ready.
  useEffect(() => {
    if (!userId) return;
    identifyDash0User(userId);
  }, [userId]);

  return null;
}
