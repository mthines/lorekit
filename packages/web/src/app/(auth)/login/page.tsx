import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { AuthHashCatcher } from '@/components/auth/AuthHashCatcher';
import { LoginButton } from '@/components/auth/LoginButton';
import { LandingBackdrop } from '@/components/landing/LandingBackdrop';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to LoreKit — shared, persistent memory for AI coding agents.',
};

/**
 * The sign-in page, and only that.
 *
 * It used to carry the whole marketing site as well, because `/` redirected
 * here — so the product's pitch lived on an auth route, and a visitor met a
 * sign-in form before an explanation. The pitch now lives at `/`; what remains
 * here is the one job the URL names, plus a way back for anyone who arrived
 * without knowing what they are signing in to.
 */
export default function LoginPage() {
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
          Sign in to LoreKit
        </h1>

        <p className="mb-10 max-w-md text-center text-base text-[var(--color-content-secondary)]">
          An account connects the same memory store to every machine, teammate, and CI
          run. The CLI itself works offline without one.
        </p>

        <div className="flex flex-col items-center gap-3">
          <Suspense fallback={null}>
            <LoginButton />
          </Suspense>
          <p className="text-sm text-[var(--color-content-secondary)]">
            Free — 5,000 memories, no card
          </p>
        </div>

        <p className="mt-12 text-sm text-[var(--color-content-secondary)]">
          New here?{' '}
          <Link
            href="/"
            className="rounded font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            See what LoreKit does
          </Link>
        </p>
      </section>

      <SiteFooter className="relative z-10" />
    </main>
  );
}
