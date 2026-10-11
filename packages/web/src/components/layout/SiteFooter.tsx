import type { ComponentPropsWithoutRef } from 'react';
import { BookText, FileCode, Newspaper } from 'lucide-react';

import { GitHubMark } from '@/components/ui/GitHubMark';

const DISCORD_URL = 'https://discord.gg/B9m6BzMRjg';
const ICON_LINK_CLASS =
  'inline-flex items-center gap-1.5 transition-colors duration-200 hover:text-[var(--color-content-primary)]';

/**
 * Shared, deliberately subtle site footer rendered both on the public login
 * page and across every authenticated dashboard page, so the GitHub repo and
 * Discord support links are reachable from anywhere.
 *
 * It keeps to a single low-key line (tertiary text → primary on hover) so it
 * never competes with page content. The GitHub link mirrors the repo link in
 * the login page header; the Discord link invites people to join for support.
 */
export function SiteFooter({ className = '', ...props }: ComponentPropsWithoutRef<'footer'>) {
  return (
    <footer
      className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-[var(--color-border)] px-6 py-5 text-xs text-[var(--color-content-tertiary)] ${className}`}
      {...props}
    >
      <a
        href="https://github.com/mthines/lorekit"
        target="_blank"
        rel="noopener noreferrer"
        className={ICON_LINK_CLASS}
      >
        <GitHubMark className="size-4" />
        GitHub
      </a>

      <span aria-hidden className="text-[var(--color-border)]">·</span>

      <a
        href={DISCORD_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={ICON_LINK_CLASS}
      >
        <svg
          aria-hidden
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="size-4"
        >
          <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.099.246.197.373.291a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.893.077.077 0 0 0-.041.106c.36.699.772 1.363 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028ZM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.42 0 1.333-.955 2.418-2.157 2.418Zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418Z" />
        </svg>
        Discord
      </a>

      <span aria-hidden className="text-[var(--color-border)]">·</span>

      <a href="/docs" className={ICON_LINK_CLASS}>
        <BookText aria-hidden className="size-4" />
        Docs
      </a>

      <span aria-hidden className="text-[var(--color-border)]">·</span>

      <a href="/blog" className={ICON_LINK_CLASS}>
        <Newspaper aria-hidden className="size-4" />
        Blog
      </a>

      <span aria-hidden className="text-[var(--color-border)]">·</span>

      <a
        href="/api-docs"
        target="_blank"
        rel="noopener noreferrer"
        className={ICON_LINK_CLASS}
      >
        <FileCode aria-hidden className="size-4" />
        API docs
      </a>

      <span aria-hidden className="text-[var(--color-border)]">·</span>

      <span>
        Need help? Join our{' '}
        <a
          href={DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 transition-colors duration-200 hover:text-[var(--color-content-primary)] hover:underline"
        >
          Discord
        </a>{' '}
        for support.
      </span>
    </footer>
  );
}
