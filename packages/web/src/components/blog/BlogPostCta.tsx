import Link from 'next/link';
import { ArrowRight, BookOpen, Github } from 'lucide-react';
import { CopyCommand } from '@/components/landing/CopyCommand';

/**
 * The shared call-to-action at the foot of every blog post. Rendered once by the
 * post route (not per-MDX), so it can't drift between posts.
 *
 * Install-first on purpose: the blog's whole pitch is "no signup, just a folder",
 * so the primary action is the copyable local-install command — the frictionless
 * ask the posts already earned. Creating an account is the SECONDARY path, framed
 * for the reader who wants a shared/team store, so neither the copy nor the link
 * contradicts the local-first story.
 */
export function BlogPostCta() {
  return (
    <aside
      aria-labelledby="blog-cta-heading"
      className="mt-14 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6"
    >
      <h2
        id="blog-cta-heading"
        className="text-lg font-semibold tracking-tight text-[var(--color-content-primary)]"
      >
        Give your coding agent a memory
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-content-secondary)]">
        One command, a folder you own, no signup. Start local today.
      </p>

      <div className="mt-4">
        <CopyCommand command="npx @lorekit/cli install" commandId="cli-install" surface="blog-cta" />
      </div>

      <p className="mt-4 text-sm text-[var(--color-content-secondary)]">
        Sharing with a team?{' '}
        <Link
          href="/login"
          className="inline-flex items-center gap-1 font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          Create a free account
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--color-border-subtle)] pt-4 text-xs text-[var(--color-content-tertiary)]">
        <Link
          href="/docs"
          className="inline-flex items-center gap-1.5 py-1 transition-colors hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          <BookOpen className="size-3.5" aria-hidden />
          Read the docs
        </Link>
        <a
          href="https://github.com/mthines/lorekit"
          className="inline-flex items-center gap-1.5 py-1 transition-colors hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          <Github className="size-3.5" aria-hidden />
          Star on GitHub
        </a>
      </div>
    </aside>
  );
}
