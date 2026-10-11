import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { GitHubMark } from '@/components/ui/GitHubMark';

import { LandingLink } from './LandingLink';

// Docs and Blog share one style and one breakpoint: hidden below `sm` so the
// mobile header keeps room for the GitHub icon and the Sign in control.
const HEADER_TEXT_LINK_CLASS =
  'hidden items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-content-secondary)] transition-colors duration-200 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] sm:inline-flex';

/**
 * The public site header, shared by the marketing home page (`/`) and the sign-in
 * page (`/login`).
 *
 * It takes the sign-in control as a slot rather than rendering one itself,
 * because the two pages need different things there and the difference is
 * behavioural, not cosmetic: on `/` the control is a plain link to the sign-in
 * page (a header button that fires GitHub OAuth on click does something the
 * label "Sign in" does not say), while `/login` passes the compact
 * `LoginButton`, which is that OAuth trigger and is correct once the visitor
 * has already chosen to sign in.
 *
 * Every outbound link reports `landing.cta_clicked` with `placement: 'header'`.
 * The header renders on `/login` too, so those clicks carry that page's path —
 * filter on `page.url.path` when only the home page is wanted. The logo is not
 * tracked: it links to the page the visitor is already on.
 *
 * Sticky with a translucent, blurred fill, so Docs and Sign in stay one click
 * away on a long page without the bar ever hiding the content scrolling under
 * it. Sticky only works because the pages' `<main>` clips with `overflow-x-clip`
 * rather than `overflow-hidden` — the latter makes `<main>` a scroll container
 * and the header would stick to a box that never scrolls.
 */
export function LandingHeader({ action }: { action?: ReactNode }) {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg)]/70 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          aria-label="LoreKit — home"
        >
          <Image
            src="/icons/icon-192.png"
            alt=""
            width={32}
            height={32}
            className="shrink-0 rounded-xl"
            priority
          />
          <span className="text-sm font-semibold text-[var(--color-content-primary)]">LoreKit</span>
        </Link>

        <nav aria-label="Site" className="flex items-center gap-1 sm:gap-2">
          <LandingLink href="/docs" cta="docs" placement="header" className={HEADER_TEXT_LINK_CLASS}>
            Docs
          </LandingLink>
          <LandingLink href="/blog" cta="blog" placement="header" className={HEADER_TEXT_LINK_CLASS}>
            Blog
          </LandingLink>
          <LandingLink
            href="https://github.com/mthines/lorekit"
            cta="github"
            placement="header"
            ariaLabel="View source on GitHub"
            className="flex size-11 items-center justify-center rounded-lg text-[var(--color-content-secondary)] transition-colors duration-200 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            <GitHubMark className="size-5" />
          </LandingLink>
          {action ?? (
            <LandingLink
              href="/login"
              cta="sign-in"
              placement="header"
              className="flex h-9 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 text-sm font-medium text-[var(--color-content-primary)] transition-colors duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            >
              Sign in
            </LandingLink>
          )}
        </nav>
      </div>
    </header>
  );
}
