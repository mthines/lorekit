import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { DocsNav } from '@/components/docs/DocsNav';
import { DocsSearch } from '@/components/docs/DocsSearch';
import { DocsAuthCta } from '@/components/docs/DocsAuthCta';
import { DocsCommands } from '@/components/docs/DocsCommands';
import { DocsSessionCommands } from '@/components/docs/DocsSessionCommands';
import { getDocsSearchIndex } from '@/lib/docs/content';
import { CommandPaletteProvider } from '@/components/command/CommandPaletteProvider';
import { CommandPalette } from '@/components/command/CommandPalette';
import { CommandPaletteButton } from '@/components/command/CommandPaletteButton';

export const metadata: Metadata = {
  title: { default: 'Documentation', template: '%s — LoreKit docs' },
  description: 'Guides and reference for LoreKit — shared, persistent memory for AI coding agents.',
};

/**
 * Public docs shell. Deliberately NOT under `(dashboard)` — it has no auth gate,
 * so a logged-out visitor can read every guide. Provides its own chrome (logo,
 * full-text search, sign-in CTA), the `/docs` nav rail, and the shared footer.
 *
 * The search index is read once, server-side, and embedded into this statically
 * rendered layout, so search works with zero runtime filesystem access.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const searchIndex = getDocsSearchIndex();

  return (
    // CommandPaletteProvider runs the global ⌘K listener and holds the command
    // registry; a client provider wrapping server-rendered children is valid in
    // the App Router. CommandPalette renders the overlay portal and DocsCommands
    // registers the docs-page navigation commands.
    <CommandPaletteProvider>
      <CommandPalette />
      <DocsCommands />
      <DocsSessionCommands />
      <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
        <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 px-6 py-2.5 backdrop-blur sm:h-14 sm:py-0 md:px-10">
          <Link href="/" className="order-1 flex shrink-0 items-center gap-2.5">
            <Image
              src="/icons/icon-192.png"
              alt="LoreKit"
              width={28}
              height={28}
              className="shrink-0 rounded-lg"
              priority
            />
            <span className="text-sm font-semibold text-[var(--color-content-primary)]">
              LoreKit <span className="text-[var(--color-content-tertiary)]">docs</span>
            </span>
          </Link>

          {/*
            One search instance, repositioned by flex `order` — centred on desktop,
            full-width on its own row on mobile — so the (~33 KB flattened) search
            index is serialised into the docs payload only ONCE, not per breakpoint.
          */}
          <div className="order-3 w-full sm:order-2 sm:flex sm:w-auto sm:flex-1 sm:justify-center">
            <DocsSearch index={searchIndex} />
          </div>

          <div className="order-2 flex items-center gap-3 sm:order-3">
            {/* ⌘K trigger — hidden on mobile (the touch overlay has no keyboard
                shortcut affordance) so the header doesn't crowd on small screens. */}
            <span className="hidden sm:inline-flex">
              <CommandPaletteButton />
            </span>
            <DocsAuthCta />
          </div>
        </header>

        {/* Left-aligned (flush with the nav rail, like the dashboard) rather than a
            centred column; the content itself is capped at a readable measure. */}
        <div className="flex w-full flex-1 flex-col gap-8 px-6 py-8 md:flex-row md:gap-12 md:px-10 md:py-10">
          <DocsNav />
          <main className="min-w-0 max-w-3xl flex-1">{children}</main>
        </div>

        <SiteFooter />
      </div>
    </CommandPaletteProvider>
  );
}
