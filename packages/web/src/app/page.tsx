import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AuthHashCatcher } from '@/components/auth/AuthHashCatcher';
import { ReadingTelemetry } from '@/components/content/ReadingTelemetry';
import { BeforeAfter } from '@/components/landing/BeforeAfter';
import { FeatureBento } from '@/components/landing/FeatureBento';
import { GetStartedCard } from '@/components/landing/GetStartedCard';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { LandingBackdrop } from '@/components/landing/LandingBackdrop';
import { LandingHeader } from '@/components/landing/LandingHeader';
import { LandingHero } from '@/components/landing/LandingHero';
import { Limitations } from '@/components/landing/Limitations';
import { LANDING_SECTION_ORDER } from '@/components/landing/sections';
import { TerminalTheater } from '@/components/landing/TerminalTheater';
import { WhereLoreLives } from '@/components/landing/WhereLoreLives';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { classifyAuthCallback } from '@/lib/auth-callback-params';
import { getVerifiedUser } from '@/lib/auth/verified-user';

type SearchParams = Record<string, string | string[] | undefined>;

export const metadata: Metadata = {
  title: 'Shared memory for your coding agents',
  description:
    'LoreKit gives your AI coding agents a shared, persistent memory. One command to connect — hosted across every machine, teammate, and CI run, or fully offline with no account.',
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
  // AuthHashCatcher mounted below. It is mounted here IN ADDITION to /login, not
  // moved from it: this page used to bounce every visitor to /login, so the
  // /login catcher received the fragments that land on the Site URL. With the
  // bounce gone those fragments stay here, while a fragment that lands on
  // /login directly still needs the one there.
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

  // Reading order is an argument, not a feature list:
  //   promise (hero) → proof (the live demo, peeking above the fold as the
  //   hero's product shot) → the pain it removes → how → what you get → where
  //   your data sits → what it won't do → the same action again.
  // The demo sits directly under the hero because a visitor decides within the
  // first screen whether to keep reading, and "session B already knows" lands
  // faster as a picture than as any sentence above it.
  //
  // `overflow-x-clip`, not `overflow-hidden`: hidden makes <main> a scroll
  // container, and the sticky header would stick to a box that never scrolls.
  //
  // Reading telemetry is the blog's (`ReadingTelemetry`, `contentType:
  // 'landing'`), measured against the `data-reading-content` wrapper — hero to
  // closing card, header and footer excluded — so 100 % means "reached the
  // closing call to action", not "scrolled past the footer links". The selector
  // is explicit because the default (`article`) would match the first card on
  // the page. The wrapper is a real box, not `display: contents`: an element
  // with no box measures zero high, which `readPercent` reports as 0 %.
  // `LANDING_SECTION_ORDER` must list the sections in the order rendered below.
  return (
    <main className="relative flex min-h-screen flex-col overflow-x-clip bg-[var(--color-bg)]">
      <AuthHashCatcher />
      <ReadingTelemetry
        contentType="landing"
        slug="home"
        sectionIds={LANDING_SECTION_ORDER}
        contentSelector="[data-reading-content]"
      />
      <LandingBackdrop />
      <LandingHeader />

      <div data-reading-content className="relative z-10 flex flex-col">
        <LandingHero />

        <div className="flex flex-col items-center gap-28 px-6 pb-16 sm:gap-36">
          <TerminalTheater />
          <BeforeAfter />
          <HowItWorks />
          <FeatureBento />
          <WhereLoreLives />
          <Limitations />
          <GetStartedCard />
        </div>
      </div>

      <SiteFooter className="relative z-10 mt-16" />
    </main>
  );
}
