'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

/**
 * Small hydration island for the public docs header: shows "Open dashboard" to a
 * signed-in reader and "Sign in" to everyone else. Kept client-side (a browser
 * session check) so the rest of the `/docs` layout stays statically rendered.
 *
 * Until the session resolves it renders the neutral "Sign in" affordance, so the
 * header never flashes empty; a logged-in reader briefly sees "Sign in" then it
 * swaps to "Open dashboard".
 */
export function DocsAuthCta() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!cancelled) setSignedIn(Boolean(data.session));
      })
      .catch(() => {
        /* stay signed-out on any error */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const href = signedIn ? '/dashboard' : '/login';
  const label = signedIn ? 'Open dashboard' : 'Sign in';

  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[#000] transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
    >
      {label}
      <ArrowRight className="size-4" aria-hidden />
    </Link>
  );
}
