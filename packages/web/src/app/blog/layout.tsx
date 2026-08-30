import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { BookText } from 'lucide-react';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { DocsAuthCta } from '@/components/docs/DocsAuthCta';
import { BlogCommands } from '@/components/blog/BlogCommands';
import { DocsSessionCommands } from '@/components/docs/DocsSessionCommands';
import { CommandPaletteProvider } from '@/components/command/CommandPaletteProvider';
import { CommandPalette } from '@/components/command/CommandPalette';
import { CommandPaletteButton } from '@/components/command/CommandPaletteButton';

export const metadata: Metadata = {
  title: { default: 'Blog', template: '%s — LoreKit blog' },
  description: 'Notes on shared, persistent memory for AI coding agents — from the team building LoreKit.',
};

/**
 * Public blog shell. Like `/docs`, deliberately NOT under `(dashboard)` — no auth
 * gate, so a logged-out visitor reads every post. Provides its own chrome (logo,
 * a link across to the docs, sign-in CTA) and the shared footer. Each page owns
 * its own content column: the index lays out a post list, a post page lays out
 * the article + the scroll-spy TOC rail.
 *
 * The command palette (⌘K) runs here too — same as `/docs`. `BlogCommands`
 * registers one command per post (so ⌘K + typing = "search in blog"), and
 * `DocsSessionCommands` adds the "Navigate" group back into the app for a
 * signed-in visitor. A client provider wrapping server-rendered children is
 * valid in the App Router.
 */
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <CommandPaletteProvider>
      <CommandPalette />
      <BlogCommands />
      <DocsSessionCommands />
      <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 px-6 py-2.5 backdrop-blur sm:h-14 sm:py-0 md:px-10">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <Image
              src="/icons/icon-192.png"
              alt="LoreKit"
              width={28}
              height={28}
              className="shrink-0 rounded-lg"
              priority
            />
            <span className="text-sm font-semibold text-[var(--color-content-primary)]">
              LoreKit <span className="text-[var(--color-content-tertiary)]">blog</span>
            </span>
          </Link>

          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-[var(--color-content-secondary)] transition-colors duration-200 hover:text-[var(--color-content-primary)]"
            >
              <BookText className="size-4" aria-hidden />
              Docs
            </Link>
            {/* ⌘K trigger — hidden on mobile (the touch overlay has no keyboard
                affordance), matching the docs header. */}
            <span className="hidden sm:inline-flex">
              <CommandPaletteButton />
            </span>
            <DocsAuthCta />
          </div>
        </header>

        <div className="w-full flex-1 px-6 py-8 md:px-10 md:py-12">{children}</div>

        <SiteFooter />
      </div>
    </CommandPaletteProvider>
  );
}
