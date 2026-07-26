import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createServerClient } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { Dash0Provider } from '@/components/providers/Dash0Provider';
import { MemorySidebarProvider } from '@/components/providers/MemorySidebarProvider';
import { ToastProvider } from '@/components/providers/ToastProvider';
import { OnboardingProvider } from '@/components/providers/OnboardingProvider';
import { getOnboardingState } from '@/lib/onboarding-server';
import { Toaster } from 'sonner';

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
      <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg)] md:flex-row">
        {/* Pass userId so Dash0Provider can call identify() and attach
            the opaque user ID to all subsequent RUM telemetry */}
        <Dash0Provider userId={user.id} />
        <Sidebar user={user} />
        {/*
          MemorySidebarProvider wraps both the TopBar and the page content so the
          lesson detail sheet is available site-wide AND the TopBar's
          MemoryExpandButton can consume the context. It uses useSearchParams
          internally, which requires a Suspense boundary in Next.js App Router.
        */}
        <Suspense fallback={null}>
          <MemorySidebarProvider>
            <div className="flex flex-1 flex-col overflow-hidden">
              <TopBar user={user} />
              <main className="flex-1 overflow-y-auto p-4 pb-20 md:pb-6 md:p-6">{children}</main>
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
    </OnboardingProvider>
    </ToastProvider>
  );
}
