import { ArrowRight, Check } from 'lucide-react';

import { GitHubMark } from '@/components/ui/GitHubMark';
import type { LandingCta } from '@/lib/analytics/track';

import { CopyCommand } from './CopyCommand';
import { LandingLink } from './LandingLink';
import { LANDING_SECTION_ID } from './sections';

/** Each claim is checkable: the plan limit is the free-plan memory cap
 *  (`docs/limits.md`), the tool list names the integration level rather than
 *  implying every MCP host is equally supported, and all three stores exist
 *  today (see "Where your lore lives" further down). */
const TRUST_POINTS = [
  'Free · 5,000 memories',
  'Claude Code · Cursor · any MCP client',
  'Local, hosted, or self-hosted',
] as const;

/**
 * What happens after the command, stated as the two real paths.
 *
 * `install` prompts for a token. With one, the agent talks to the hosted store.
 * Left blank, it STILL writes the hosted MCP entry (`packages/cli/src/commands/
 * install.mjs`) — offline needs the local MCP entry plus `"mode": "local"` in
 * `.lorekit.json` (`/docs/offline`, steps 3 and 6). The page used to say "works
 * offline with no account" directly under the command, which a visitor reads
 * as "this one command gives me an offline setup" — and then meets an agent
 * pointed at a server it has no token for. Naming both paths, at equal weight,
 * costs one line and removes that first-run failure.
 *
 * Each path reports its own `landing.cta_clicked` intent, so the ratio of
 * `get-token` to `offline-guide` from `placement: 'hero'` is the direct answer
 * to "which path do visitors want?" — read it next to `install_command.copied`.
 */
const NEXT_STEPS: readonly {
  label: string;
  body: string;
  href: string;
  linkText: string;
  cta: LandingCta;
}[] = [
  {
    label: 'Hosted',
    body: 'Sign in for a free token and paste it when the installer asks.',
    href: '/login',
    linkText: 'Get a token',
    cta: 'get-token',
  },
  {
    label: 'Offline',
    body: 'No account: skip the token, then switch the store to local mode.',
    href: '/docs/offline',
    linkText: 'Offline guide',
    cta: 'offline-guide',
  },
];

/**
 * The home page's first screen.
 *
 * Its primary call to action is the install command, not the sign-in button,
 * and that ordering is the point: the command is step one of BOTH ways to use
 * LoreKit, and one of them needs no account at all, so asking a first-time
 * visitor to authenticate before anything else would be a wall in front of a
 * door that is already open. Sign-in is offered as the next step for the thing
 * an account actually buys — sharing lore across machines and teammates.
 *
 * The headline leads with the problem the visitor already has ("your agents
 * forget") and resolves it in the same breath, so the page's whole argument is
 * readable in one fixation. It is the README's own framing — "every coding
 * agent starts each session with total amnesia" — not a new claim.
 *
 * The trust points sit UNDER the command rather than above the headline: they
 * answer "is this safe to try?", which is a question asked at the moment of the
 * click, not before the visitor knows what the product is. Above the headline
 * they competed with it for the first look.
 *
 * Lines are staggered (`--lk-delay`) so the eye lands on the headline and the
 * supporting lines catch up; see `lk-rise` in `globals.css`.
 */
export function LandingHero() {
  return (
    <section
      aria-labelledby={LANDING_SECTION_ID.hero}
      className="relative z-10 flex flex-col items-center px-6 pb-14 pt-14 sm:pt-20"
    >
      <LandingLink
        href="https://github.com/mthines/lorekit"
        cta="github"
        placement="hero"
        className="lk-rise group mb-8 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80 py-1 pl-1 pr-3 text-xs text-[var(--color-content-secondary)] backdrop-blur-sm transition-colors duration-200 hover:border-[var(--color-accent)]/50 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 font-mono font-semibold text-[var(--color-accent)]">
          <GitHubMark className="size-3" />
          MIT
        </span>
        Open source — read every line on GitHub
        <ArrowRight
          aria-hidden
          className="size-3 transition-transform duration-200 group-hover:translate-x-0.5"
        />
      </LandingLink>

      <h1
        id={LANDING_SECTION_ID.hero}
        className="lk-rise mb-6 max-w-4xl text-center text-4xl font-bold leading-[1.05] tracking-tight text-[var(--color-content-primary)] sm:text-5xl lg:text-6xl"
        style={{ '--lk-delay': '60ms' } as React.CSSProperties}
      >
        <span className="block">Your coding agents forget.</span>
        {/* `pb-1` keeps the descenders inside the clipped gradient box. */}
        <span className="lk-gradient-text block pb-1">LoreKit remembers.</span>
      </h1>

      <p
        className="lk-rise mb-10 max-w-2xl text-pretty text-center text-base leading-relaxed text-[var(--color-content-secondary)] sm:text-lg"
        style={{ '--lk-delay': '120ms' } as React.CSSProperties}
      >
        Your agent works something out — why the build only breaks in CI, which migration
        needs the flag — and forgets it when the session ends. LoreKit writes it down and
        reads it back in every session after, on every machine, in every tool.
      </p>

      <div
        className="lk-rise flex w-full max-w-xl flex-col items-center gap-4"
        style={{ '--lk-delay': '180ms' } as React.CSSProperties}
      >
        <div className="w-full">
          <CopyCommand
            command="npx @lorekit/cli install"
            commandId="cli-install"
            surface="landing-hero"
            size="lg"
          />
        </div>

        <ul aria-label="Then pick a store" className="grid w-full gap-3 text-left sm:grid-cols-2">
          {NEXT_STEPS.map((step) => (
            <li
              key={step.label}
              className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]/70 px-4 py-3 backdrop-blur-sm"
            >
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-content-secondary)]">
                {step.label}
              </span>
              <span className="text-sm text-[var(--color-content-primary)]">{step.body}</span>
              <LandingLink
                href={step.href}
                cta={step.cta}
                placement="hero"
                className="group mt-1 inline-flex w-fit items-center gap-1 rounded text-sm font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
              >
                {step.linkText}
                <ArrowRight
                  aria-hidden
                  className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
                />
              </LandingLink>
            </li>
          ))}
        </ul>
      </div>

      <ul
        aria-label="At a glance"
        className="lk-rise mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-xs text-[var(--color-content-secondary)]"
        style={{ '--lk-delay': '240ms' } as React.CSSProperties}
      >
        {TRUST_POINTS.map((point) => (
          <li key={point} className="inline-flex items-center gap-1.5">
            <Check aria-hidden className="size-3.5 text-[var(--color-success)]" />
            {point}
          </li>
        ))}
      </ul>
    </section>
  );
}
