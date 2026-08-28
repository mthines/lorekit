import { Suspense } from 'react';
import { boundedReturnTo } from '@/lib/auth-redirect';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { Dash0Provider } from '@/components/providers/Dash0Provider';
import { FocusRefetcher } from '@/components/providers/FocusRefetcher';
import { MemorySidebarProvider } from '@/components/providers/MemorySidebarProvider';
import { OnboardingProvider } from '@/components/providers/OnboardingProvider';
import { FeatureFlagsProvider } from '@/components/providers/FeatureFlagsProvider';
import { getOnboardingState } from '@/lib/onboarding-server';
import { getAllServerFlagState } from '@/lib/feature-flags/server';
import { resolveDashboardBootstrap } from '@/lib/dashboard-bootstrap';
import { Toaster } from 'sonner';
import { CommandPaletteProvider } from '@/components/command/CommandPaletteProvider';
import { CommandPalette } from '@/components/command/CommandPalette';
import { NavigationCommands } from '@/components/command/NavigationCommands';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The session check and the onboarding counts are independent reads, so they
  // are OVERLAPPED rather than chained — see `lib/dashboard-bootstrap.ts` for
  // the ordering contract and why it lives there. Serially they cost the sum of
  // two Supabase round-trips on every dashboard render; a production trace of
  // `RSC GET /lore` showed 0.504s of `auth/v1/user` followed by 0.389s of
  // onboarding counts inside a 0.926s request, with nothing between them.
  //
  // `getVerifiedUser()` (lib/auth/verified-user.ts) is request-memoized via
  // React's `cache()`, so this is also the ONE `auth.getUser()` round trip
  // every other read on this render (feature flags, orgs, tokens, invites,
  // scope bindings, github installations, audit log) shares — see that
  // module's header for why: an unmemoized `getUser()` repeated across a
  // render tree multiplies any Supabase Auth latency spike by however many
  // times it's called instead of paying it once.
  //
  // Issuing the counts before the session is verified is safe because they run
  // on the RLS-scoped server client built from this request's cookies: Postgres
  // decides what they can see, an absent or expired session reads nothing, and
  // the result is discarded on the redirect path below.
  const bootstrap = await resolveDashboardBootstrap({
    getUser: async () => getVerifiedUser(),
    getOnboardingState,
    onboardingFallback: { hasLessons: false, hasWebhook: false },
  });

  if (!bootstrap) {
    // Preserve the full requested URL (path + search params like ?lesson=…) so
    // that after login, /api/auth/callback redirects back to the exact shared URL.
    // The middleware forwards x-pathname and x-search from request.nextUrl so we
    // don't need to parse the raw request here.
    const headersList = await headers();
    const pathname = headersList.get('x-pathname') ?? '/overview';
    const search = headersList.get('x-search') ?? '';
    // Bounded: this value is about to be percent-encoded a SECOND time (the
    // search string already is), so a wide Explorer filter bar would roughly
    // double on its way into ?next= and take the login redirect past the
    // header limit. Over budget, the user comes back to the bare page instead
    // of to a 431.
    const next = encodeURIComponent(boundedReturnTo(pathname, search));
    redirect(`/login?next=${next}`);
  }

  // Onboarding completion feeds both the sidebar's "Getting started" progress
  // badge and the checklist itself, so it's resolved once here and shared via
  // the provider. `getOnboardingState` is React-`cache()`d, so the pages that
  // build the checklist reuse this same request's result.
  const { user, onboardingState } = bootstrap;

  // Evaluated ONCE here, server-side, for the whole dashboard tree.
  // `FeatureFlagsProvider` hands `values` to every Client Component via
  // `useFeatureFlag`, and forwards `variants` into RUM (`dash0-rum.ts`) so
  // Web Events can be filtered/grouped by `feature_flag.<key>` — there is no
  // separate client-side evaluation to drift from this one. `user.id` is
  // passed through so this does not repeat the `auth.getUser()` call
  // `resolveDashboardBootstrap` already made above. See
  // `lib/feature-flags/server.ts`.
  const { values: flags, variants: flagVariants } = await getAllServerFlagState(user.id);

  return (
    <FeatureFlagsProvider flags={flags} variants={flagVariants}>
    <OnboardingProvider serverState={onboardingState}>
      {/*
        CommandPaletteProvider wraps the entire dashboard so the palette is
        available on every page. NavigationCommands registers the built-in
        g→h/g→e/g→s/g→l shortcuts. CommandPalette renders the overlay portal.
      */}
      <CommandPaletteProvider>
        <CommandPalette />
        <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg)] md:flex-row">
          {/* Pass userId so Dash0Provider can call identify() and attach
              the opaque user ID to all subsequent RUM telemetry */}
          <Dash0Provider userId={user.id} />
          {/* Coming back to the window (tab switch, app switch, reopening the
              PWA) refreshes the active queries — the TopBar's ActivityIndicator
              is what makes that visible. */}
          <FocusRefetcher />
          <Sidebar user={user} />
          {/*
            MemorySidebarProvider wraps both the TopBar and the page content so the
            lesson detail sheet is available site-wide AND the TopBar's
            MemoryExpandButton can consume the context. It uses useSearchParams
            internally, which requires a Suspense boundary in Next.js App Router.
          */}
          <Suspense fallback={null}>
            <MemorySidebarProvider>
              {/*
                NavigationCommands registers the palette commands. It must live
                INSIDE MemorySidebarProvider because its LoreCommands
                sub-registration consumes useMemorySidebar(); the command
                registry itself comes from the ancestor CommandPaletteProvider.
              */}
              <NavigationCommands />
              <div className="flex flex-1 flex-col overflow-hidden">
                <TopBar user={user} />
                {/*
                  Sticky-footer layout: main is the bounded scroll container. An
                  inner `min-h-full flex-col` sheet is what makes the footer
                  behave: the content grows (grow) to push the footer to the
                  bottom of the viewport on short pages, while on taller pages the
                  sheet grows past 100% so the footer flows *below* the content and
                  scrolls with it. `min-h-full` (a floor, not a cap) is the key —
                  the previous `flex-1 min-h-0` content wrapper capped its box at
                  the viewport height, so tall pages overflowed it and the footer
                  floated on top of the content instead of scrolling after it.
                */}
                {/*
                  The mobile bottom padding clears the fixed tab bar AND the
                  home-indicator inset the bar itself pads with — without the
                  `env()` term, the last row of content sits under the bar on a
                  notched phone.
                */}
                <main className="flex-1 overflow-y-auto p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
                  <div className="flex min-h-full flex-col">
                    <div className="grow">{children}</div>
                    <SiteFooter className="-mx-4 mt-8 md:-mx-6" />
                  </div>
                </main>
              </div>
            </MemorySidebarProvider>
          </Suspense>
        </div>
      {/*
        Sonner toast portal. Positioned bottom-right (default). The dark theme
        matches the LoreKit "terminal-meets-editorial" design direction: deep
        charcoal background, amber accent, mono font — all honoured by Sonner's
        `theme="dark"` which inherits the page background colour.
        richColors surfaces success in green and error in red without us having
        to style anything custom; it stays readable against the dark base.
      */}
        <Toaster
          theme="dark"
          position="bottom-right"
          richColors
          toastOptions={{
            style: {
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
            },
            duration: 3000,
          }}
        />
      </CommandPaletteProvider>
    </OnboardingProvider>
    </FeatureFlagsProvider>
  );
}
