import Link from 'next/link';

import { CopyCommand } from './CopyCommand';

/**
 * The home page's first screen.
 *
 * Its primary call to action is the install command, not the sign-in button,
 * and that ordering is the point: the CLI works with no account at all, so
 * asking a first-time visitor to authenticate before they can try anything
 * would be a wall in front of a door that is already open. Sign-in is offered
 * as the next step for the thing an account actually buys — sharing lore across
 * machines and teammates — and the copy says so instead of implying the product
 * needs one.
 *
 * The lines are staggered (`--lk-delay`) rather than arriving together, so the
 * eye lands on the headline and the supporting lines catch up; see the
 * `lk-rise` block in `globals.css` for the motion contract.
 */
export function LandingHero() {
  return (
    <section className="relative z-10 flex flex-col items-center px-6 pt-10 pb-12">
      {/* Trust bar. Each claim is checkable: the plan limit is the free-plan
          memory cap, the licence is in the repo, and the tool list names the
          integration level rather than implying all three are equal. */}
      <ul className="lk-rise mb-10 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs">
        <li className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1 font-mono text-[var(--color-content-secondary)]">
          <span className="size-1.5 rounded-full bg-[var(--color-success)]" aria-hidden />
          Free · 5,000 memories
        </li>
        <li>
          <a
            href="https://github.com/mthines/lorekit"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1 font-mono text-[var(--color-content-secondary)] transition-colors duration-200 hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            <svg aria-hidden xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="size-3.5">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            Open source · MIT
          </a>
        </li>
        <li className="inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-3 py-1 font-mono text-[var(--color-content-secondary)]">
          Claude Code · Cursor · any MCP client
        </li>
      </ul>

      <h1
        className="lk-rise mb-4 max-w-3xl text-balance text-center text-3xl font-bold tracking-tight text-[var(--color-content-primary)] sm:text-4xl lg:text-5xl"
        style={{ '--lk-delay': '60ms' } as React.CSSProperties}
      >
        Shared memory for{' '}
        <span className="text-[var(--color-accent)]">your coding agents</span>
      </h1>

      <p
        className="lk-rise mb-9 max-w-xl text-center text-base leading-relaxed text-[var(--color-content-secondary)]"
        style={{ '--lk-delay': '120ms' } as React.CSSProperties}
      >
        Your agent works something out — why the build only breaks in CI, which migration
        needs the flag — and forgets it when the session ends. LoreKit writes it down and
        reads it back in every session after, on every machine, in every tool.
      </p>

      <div
        className="lk-rise flex w-full max-w-md flex-col items-center gap-4"
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

        <p className="text-center text-sm text-[var(--color-content-secondary)]">
          Works offline with no account. Sign in when you want lessons shared across
          machines and teammates.
        </p>

        <p className="flex items-center gap-3 text-sm">
          <Link
            href="/login"
            className="rounded font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            Sign in
          </Link>
          <span aria-hidden className="text-[var(--color-border)]">·</span>
          <Link
            href="/docs"
            className="rounded text-[var(--color-content-secondary)] underline-offset-2 hover:text-[var(--color-content-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            Read the docs
          </Link>
        </p>
      </div>
    </section>
  );
}
