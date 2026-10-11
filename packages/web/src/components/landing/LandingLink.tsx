'use client';

import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';

import { track, type LandingCta, type LandingPlacement } from '@/lib/analytics/track';

/**
 * A home-page link that reports `landing.cta_clicked` when it is followed.
 *
 * Every link on the page goes through this one component, because the
 * question the data has to answer is comparative — hosted or offline? header
 * or hero? — and a comparison with one side untracked reads as a preference.
 *
 * `cta` and `placement` are closed unions (see `lib/analytics/track.ts`), so a
 * new link costs a type error until someone decides what intent it represents,
 * rather than arriving with a free-text label as its id.
 *
 * External hrefs open in a new tab, so the current page — and the SDK batch
 * carrying this event — stays alive. Internal hrefs are client-side `next/link`
 * navigations, which never unload the document either. A middle-click opens a
 * tab without firing `click`, so it is counted from `auxclick`.
 */
export function LandingLink({
  href,
  cta,
  placement,
  className,
  children,
  ariaLabel,
}: {
  href: string;
  cta: LandingCta;
  placement: LandingPlacement;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  const report = () => track({ name: 'landing.cta_clicked', cta, placement });
  const onAuxClick = (event: MouseEvent) => {
    if (event.button === 1) report();
  };

  if (/^https?:\/\//.test(href)) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={ariaLabel}
        className={className}
        onClick={report}
        onAuxClick={onAuxClick}
      >
        {children}
      </a>
    );
  }

  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className={className}
      onClick={report}
      onAuxClick={onAuxClick}
    >
      {children}
    </Link>
  );
}
