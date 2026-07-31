import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { DocsNav } from '@/components/docs/DocsNav';
import { DocsSearch } from '@/components/docs/DocsSearch';
import { DocsAuthCta } from '@/components/docs/DocsAuthCta';
import { getDocsSearchIndex } from '@/lib/docs/content';

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
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)]">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 px-6 py-3 backdrop-blur sm:h-16 sm:py-0 md:px-10">
        <Link href="/" className="order-1 flex shrink-0 items-center gap-2.5">
          <Image
            src="/icons/icon-192.png"
            alt="LoreKit"
            width={32}
            height={32}
            className="shrink-0 rounded-xl"
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

        <div className="order-2 sm:order-3">
          <DocsAuthCta />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-8 md:flex-row md:gap-10 md:py-12">
        <DocsNav />
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <SiteFooter />
    </div>
  );
}
