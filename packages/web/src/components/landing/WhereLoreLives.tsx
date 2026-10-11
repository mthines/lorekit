import { Cloud, HardDrive, Server, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';

import { SectionHeading } from './SectionHeading';

type Store = {
  name: string;
  summary: string;
  body: string;
  icon: LucideIcon;
  /** The option that needs nothing from us — framed so it is never a footnote. */
  needsNoAccount?: boolean;
};

const STORES: Store[] = [
  {
    name: 'Local',
    summary: 'No account, no network.',
    body: 'Markdown files under ~/.lorekit and <repo>/.lorekit — greppable, diffable, and yours. Commit them to share via git, or gitignore them to keep them private.',
    icon: HardDrive,
    needsNoAccount: true,
  },
  {
    name: 'Hosted',
    summary: 'Shared across machines and teammates.',
    body: 'Every memory is personal by default; org sharing is opt-in. The free plan holds 5,000 active memories at 120 requests a minute.',
    icon: Cloud,
  },
  {
    name: 'Self-hosted',
    summary: 'Your own infrastructure.',
    body: 'The whole stack — MCP server, dashboard, database — deploys to your own Supabase and Vercel projects. MIT licensed.',
    icon: Server,
  },
];

/**
 * Where the data physically sits, stated before anyone has to ask.
 *
 * "Is this a service that stores my repository's internals?" is the first
 * question a developer asks about a memory product and the last thing most
 * landing pages answer. All three answers are true of LoreKit today, and the
 * local one — which needs no account at all — is listed FIRST and carries the
 * page's amber frame. Burying the option that needs nothing from us would be
 * steering rather than informing.
 */
export function WhereLoreLives() {
  return (
    <section aria-labelledby="where-lore-lives" className="lk-reveal w-full max-w-5xl">
      <SectionHeading
        id="where-lore-lives"
        eyebrow="04 / where your lore lives"
        title={
          <>
            Your lore, <span className="lk-gradient-text">your call.</span>
          </>
        }
        lede="The same memory tools run against any of the three."
      />

      <ul className="grid gap-5 sm:grid-cols-3">
        {STORES.map(({ name, summary, body, icon: Icon, needsNoAccount }) => (
          <li
            key={name}
            className={cn(
              'relative flex flex-col gap-3 rounded-2xl p-6',
              needsNoAccount
                ? 'lk-glow-frame'
                : 'border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80',
            )}
          >
            <div className="flex items-center justify-between">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-accent)]"
              >
                <Icon className="size-4" />
              </span>
              {needsNoAccount && (
                <span className="rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-[var(--color-accent)]">
                  Fully offline
                </span>
              )}
            </div>
            <h3 className="text-base font-semibold text-[var(--color-content-primary)]">{name}</h3>
            <p className="text-sm font-medium text-[var(--color-accent)]">{summary}</p>
            <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">{body}</p>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-center text-sm text-[var(--color-content-secondary)]">
        Start local and move up later —{' '}
        <code className="rounded bg-[var(--color-bg-elevated)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-accent)]">
          lorekit migrate
        </code>{' '}
        previews the whole plan before it changes anything.
      </p>
    </section>
  );
}
