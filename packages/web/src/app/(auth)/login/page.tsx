import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthHashCatcher } from '@/components/auth/AuthHashCatcher';
import { LoginButton } from '@/components/auth/LoginButton';
import { LandingBackdrop } from '@/components/landing/LandingBackdrop';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { AUTH_ENTRY_MODE_PARAM, authEntryHref, parseAuthEntryMode } from '@/lib/auth-entry-mode';

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Copy per entry mode. One page, two greetings — see `lib/auth-entry-mode.ts`. */
const COPY = {
  signin: {
    title: 'Sign in',
    heading: 'Sign in to LoreKit',
    lede: 'An account connects the same memory store to every machine, teammate, and CI run. The CLI itself works offline without one.',
  },
  signup: {
    title: 'Create your free account',
    heading: 'Create your free LoreKit account',
    lede: 'Get a token that connects the same memory store to every machine, teammate, and CI run. Takes under a minute.',
  },
} as const;

const INLINE_LINK_CLASS =
  'rounded font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]';

export async function generateMetadata({ searchParams }: LoginPageProps): Promise<Metadata> {
  const mode = parseAuthEntryMode((await searchParams)[AUTH_ENTRY_MODE_PARAM]);
  return {
    title: COPY[mode].title,
    description: `${COPY[mode].heading} — shared, persistent memory for AI coding agents.`,
  };
}

/**
 * The sign-in page, and only that.
 *
 * It used to carry the whole marketing site as well, because `/` redirected
 * here — so the product's pitch lived on an auth route, and a visitor met a
 * sign-in form before an explanation. The pitch now lives at `/`; what remains
 * here is the one job the URL names, plus a way back for anyone who arrived
 * without knowing what they are signing in to.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const mode = parseAuthEntryMode(params[AUTH_ENTRY_MODE_PARAM]);
  const copy = COPY[mode];
  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[var(--color-bg)]">
      {/*
        Renders nothing on an ordinary visit. Only fires when Supabase bounced
        an implicit-flow auth result to the Site URL instead of the callback
        route — see AuthHashCatcher.
      */}
      <AuthHashCatcher />

      <LandingBackdrop />

      <LandingHeader
        action={
          <Suspense fallback={null}>
            <LoginButton compact />
          </Suspense>
        }
      />

      <section className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-16">
        <h1 className="mb-3 max-w-xl text-center text-3xl font-bold tracking-tight text-[var(--color-content-primary)] sm:text-4xl">
          {copy.heading}
        </h1>

        <p className="mb-10 max-w-md text-center text-base text-[var(--color-content-secondary)]">
          {copy.lede}
        </p>

        <div className="flex flex-col items-center gap-3">
          <Suspense fallback={null}>
            {/* Keyed by mode: switching between the sign-in and sign-up links is
                a client navigation to the same route, and without a remount the
                email form would keep the previous mode's state. */}
            <LoginButton key={mode} />
          </Suspense>
          <p className="text-sm text-[var(--color-content-secondary)]">
            Free — 5,000 memories, no card
          </p>
          {/* GitHub and the magic link create the account on first use. Say so:
              a newcomer reading "Sign in" otherwise assumes this is not for them. */}
          {mode === 'signin' && (
            <p className="max-w-xs text-center text-xs text-[var(--color-content-tertiary)]">
              No account yet? GitHub and magic link create one for you automatically.
            </p>
          )}
        </div>

        <p className="mt-12 text-center text-sm text-[var(--color-content-secondary)]">
          {mode === 'signin' ? (
            <>
              New here?{' '}
              <Link href={authEntryHref('signup', params['next'])} className={INLINE_LINK_CLASS}>
                Create a free account
              </Link>{' '}
              or{' '}
              <Link href="/" className={INLINE_LINK_CLASS}>
                see what LoreKit does
              </Link>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <Link href={authEntryHref('signin', params['next'])} className={INLINE_LINK_CLASS}>
                Sign in
              </Link>
            </>
          )}
        </p>
      </section>

      <SiteFooter className="relative z-10" />
    </main>
  );
}
