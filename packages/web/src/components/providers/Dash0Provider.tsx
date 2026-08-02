'use client';

/**
 * Dash0Provider — attaches identity and route context to browser RUM.
 *
 * The SDK itself is initialised by `lib/dash0-rum.ts`, which
 * `instrumentation-client.ts` calls before React mounts. This component calls
 * the same idempotent initialiser (so the SDK is up even if the Next.js hook
 * did not run) and then owns the two things that need the React tree:
 *
 *   1. Upgrading the anonymous visitor id to the authenticated user id.
 *   2. Emitting the current route on every client-side navigation.
 *
 * Mount it in the ROOT layout so public pages — marketing, `/docs`, `/login` —
 * get route tracking too, and pass `userId` from the authenticated layout. It
 * is safe to mount twice: initialisation is guarded, and both mounts set the
 * same attributes.
 *
 * VCS resource attributes are read from NEXT_PUBLIC_VCS_* env vars baked in at
 * build time via next.config.ts (sourced from Vercel system env vars).
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

import { initDash0Rum, identifyDash0User, setDash0PagePath } from '@/lib/dash0-rum';

interface Dash0ProviderProps {
  /**
   * Authenticated user ID (opaque UUID). Pass from the server after login.
   * Omitted on public pages, where the visitor keeps the anonymous id
   * `initDash0Rum` assigned.
   */
  userId?: string;
}

export function Dash0Provider({ userId }: Dash0ProviderProps) {
  const pathname = usePathname();
  const prevPathname = useRef<string | null>(null);

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

  // Emit the current route on every client-side navigation.
  useEffect(() => {
    if (prevPathname.current === pathname) return;
    prevPathname.current = pathname;
    setDash0PagePath(pathname);
  }, [pathname]);

  return null;
}
