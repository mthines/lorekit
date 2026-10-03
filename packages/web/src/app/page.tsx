import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AuthHashCatcher } from '@/components/auth/AuthHashCatcher';
import { GetStartedCard } from '@/components/landing/GetStartedCard';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { LandingBackdrop } from '@/components/landing/LandingBackdrop';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { LandingHero } from '@/components/landing/LandingHero';
import { Limitations } from '@/components/landing/Limitations';
import { MemoryCost } from '@/components/landing/MemoryCost';
import { TerminalTheater } from '@/components/landing/TerminalTheater';
import { WhereLoreLives } from '@/components/landing/WhereLoreLives';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { classifyAuthCallback } from '@/lib/auth-callback-params';
import { getVerifiedUser } from '@/lib/auth/verified-user';

type SearchParams = Record<string, string | string[] | undefined>;

export const metadata: Metadata = {
  title: 'Shared memory for your coding agents',
  description:
    'LoreKit gives your AI coding agents a shared, persistent memory. One command to connect — offline with no account, or hosted across every machine, teammate, and CI run.',
};

function toURLSearchParams(input: SearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') params.append(key, value);
    else if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
  }
  return params;
}

/**
 * The public home page.
 *
 * It used to be a bare `redirect('/login')`, which made the front door an auth
 * route titled "Sign in": a visitor who did not already know what LoreKit was
 * met a form before an explanation, and the product's strongest verifiable
 * claims — one command, works with no account, MIT, self-hostable — sat below
 * the fold of a page they had no reason to scroll. `/login` now does the one
 * job its URL names, and this page does the other.
 *
 * A signed-in visitor still never sees it: they are sent to `/lore`, the app's
 * home slot, exactly as before.
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = toURLSearchParams(await searchParams);

  // Supabase falls back to the project's **Site URL** when an email link's
  // `redirect_to` is not on the allow-list — which lands the user here,
  // mid-authentication, instead of on /api/auth/callback. Forward the auth
  // params on rather than dropping them on the marketing page.
  //
  // Only the query-string shapes can be rescued server-side; an implicit-flow
  // `#access_token=…` fragment never reaches the server and is picked up by the
  // AuthHashCatcher mounted below. It has to be mounted HERE now: this page no
  // longer redirects to /login, so the catcher that used to receive those
  // fragments there would never run.
  if (classifyAuthCallback(params).kind !== 'none') {
    if (!params.has('next')) params.set('next', '/welcome');
    redirect(`/api/auth/callback?${params.toString()}`);
  }

  const user = await getVerifiedUser();
  if (user) {
    // `/lore` is the app's home slot — `buildOnboardingSteps({
    // autoGenerateToken: true })` mints a brand-new user's first API token
    // there, so landing anywhere else leaves a fresh signup with no token and
    // no setup instructions. See Sidebar.tsx's nav and lore/page.tsx.
    redirect('/lore');
  }

  return (
    <main className="relative flex min-h-screen flex-col overflow-hidden bg-[var(--color-bg)]">
      <AuthHashCatcher />
      <LandingBackdrop />
      <LandingHeader />

      <LandingHero />

      <div className="relative z-10 flex flex-col items-center gap-20 px-6 py-12">
        <HowItWorks />
        <TerminalTheater />
        <MemoryCost />
        <WhereLoreLives />
        <Limitations />
        <GetStartedCard />
      </div>

      <SiteFooter className="relative z-10 mt-8" />
    </main>
  );
}
