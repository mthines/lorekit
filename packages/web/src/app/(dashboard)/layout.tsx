import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
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
import { Toaster } from 'sonner';
import { CommandPaletteProvider } from '@/components/command/CommandPaletteProvider';
import { CommandPalette } from '@/components/command/CommandPalette';
import { NavigationCommands } from '@/components/command/NavigationCommands';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    // Preserve the full requested URL (path + search params like ?lesson=…) so
    // that after login, /api/auth/callback redirects back to the exact shared URL.
    // The middleware forwards x-pathname and x-search from request.nextUrl so we
    // don't need to parse the raw request here.
    const headersList = await headers();
    const pathname = headersList.get('x-pathname') ?? '/dashboard';
    const search = headersList.get('x-search') ?? '';
    const next = encodeURIComponent(`${pathname}${search}`);
    redirect(`/login?next=${next}`);
  }

  // Onboarding completion feeds both the sidebar's "Getting started" progress
  // badge and the checklist itself, so it's resolved once here and shared via
  // the provider.
  const onboardingState = await getOnboardingState();

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
