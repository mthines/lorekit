'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

/**
 * Small hydration island for the public docs header: shows "Overview" to a
 * signed-in reader and "Sign in" to everyone else. Kept client-side (a browser
 * session check) so the rest of the `/docs` layout stays statically rendered.
 *
 * Until the session resolves it renders the neutral "Sign in" affordance, so the
 * header never flashes empty; a logged-in reader briefly sees "Sign in" then it
 * swaps to "Overview".
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

  const href = signedIn ? '/overview' : '/login';
  const label = signedIn ? 'Overview' : 'Sign in';

  return (
    <Link
      href={href}
      // Subtle, secondary affordance — a hairline-bordered ghost button that
      // warms to the accent on hover — so it sits with the header rather than
      // shouting over the content (was a solid amber fill).
      className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 text-sm font-medium text-[var(--color-content-secondary)] transition-colors duration-200 hover:border-[var(--color-accent-glow)] hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
    >
      {label}
      <ArrowRight className="size-3.5 opacity-70" aria-hidden />
    </Link>
  );
}
