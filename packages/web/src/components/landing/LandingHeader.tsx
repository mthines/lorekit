import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

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
 */
export function LandingHeader({ action }: { action?: ReactNode }) {
  return (
    <header className="relative z-10 flex h-16 items-center justify-between px-6 md:px-10">
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

      <div className="flex items-center gap-1 sm:gap-3">
        <Link
          href="/docs"
          className="hidden items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-content-secondary)] transition-colors duration-200 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] sm:inline-flex"
        >
          Docs
        </Link>
        <a
          href="https://github.com/mthines/lorekit"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View source on GitHub"
          className="flex size-11 items-center justify-center rounded-lg text-[var(--color-content-secondary)] transition-colors duration-200 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          <svg
            aria-hidden
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="size-5"
          >
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
        </a>
        {action ?? (
          <Link
            href="/login"
            className="flex h-9 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 text-sm font-medium text-[var(--color-content-primary)] transition-colors duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
