import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { Dash0Provider } from '@/components/providers/Dash0Provider';
import { FocusRefetcher } from '@/components/providers/FocusRefetcher';
import { MemorySidebarProvider } from '@/components/providers/MemorySidebarProvider';
import { ToastProvider } from '@/components/providers/ToastProvider';
import { OnboardingProvider } from '@/components/providers/OnboardingProvider';
import { getOnboardingState } from '@/lib/onboarding-server';
import { resolveDashboardBootstrap } from '@/lib/dashboard-bootstrap';
import { Toaster } from 'sonner';
import { CommandPaletteProvider } from '@/components/command/CommandPaletteProvider';
import { CommandPalette } from '@/components/command/CommandPalette';
import { NavigationCommands } from '@/components/command/NavigationCommands';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerClient();

  // The session check and the onboarding counts are independent reads, so they
  // are OVERLAPPED rather than chained — see `lib/dashboard-bootstrap.ts` for
  // the ordering contract and why it lives there. Serially they cost the sum of
  // two Supabase round-trips on every dashboard render; a production trace of
  // `RSC GET /lore` showed 0.504s of `auth/v1/user` followed by 0.389s of
  // onboarding counts inside a 0.926s request, with nothing between them.
  //
  // Issuing the counts before the session is verified is safe because they run
  // on the RLS-scoped server client built from this request's cookies: Postgres
  // decides what they can see, an absent or expired session reads nothing, and
  // the result is discarded on the redirect path below.
  const bootstrap = await resolveDashboardBootstrap({
    getUser: async () => (await supabase.auth.getUser()).data.user,
    getOnboardingState,
    onboardingFallback: { hasLessons: false, hasWebhook: false },
  });

  if (!bootstrap) {
    // Defence in depth, and it should be unreachable: middleware gates every
    // path in PROTECTED_SEGMENTS and redirects with the full URL preserved in
    // ?next= long before a request gets here.
    //
    // BARE on purpose. This gate cannot see the query string — the App Router
    // does not pass `searchParams` to a layout and a layout cannot reach the
    // raw `Request` — and the previous workaround (middleware copying the URL
    // into an `x-search` request header for this line to read back and encode
    // a second time) is exactly what a wide filter bar turned into a 431. Losing
    // the link on a path that should never execute is the right trade for
    // deleting that copy; if this ever fires, the fix is to bring
    // PROTECTED_SEGMENTS back in step with the route tree, not to reinstate the
    // header.
    redirect('/login');
  }

  // Onboarding completion feeds both the sidebar's "Getting started" progress
  // badge and the checklist itself, so it's resolved once here and shared via
  // the provider. `getOnboardingState` is React-`cache()`d, so the pages that
  // build the checklist reuse this same request's result.
  const { user, onboardingState } = bootstrap;

  return (
    // ToastProvider mounts once at the dashboard root — a thin sibling client
    // context (no Suspense-dependent hooks), so any settings/lore/dashboard
    // action can announce an aria-live toast (plan.md Decision D7).
    <ToastProvider>
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
                <main className="flex-1 overflow-y-auto p-4 pb-20 md:pb-6 md:p-6">
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
    </ToastProvider>
  );
}
