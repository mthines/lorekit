import { CopyCommand } from './CopyCommand';
import { LandingLink } from './LandingLink';
import { StepBadge } from './StepBadge';
import { LANDING_SECTION_ID } from './sections';

const INLINE_LINK_CLASS =
  'rounded font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]';

/**
 * The closing call to action on the home page — the page's last screen, and so
 * the one a visitor leaves with. It repeats the hero's command at full size
 * (and the same filled copy button) rather than a smaller echo of it: by this
 * point the reader has the whole argument, and the action should be exactly as
 * easy to take here as it was at the top.
 *
 * Step 1 is deliberately the command and not the sign-in: it is the first step
 * of both the hosted and the offline path. Step 2 says what the installer will
 * ask and what each answer means, because a blank token does NOT by itself
 * give an offline setup (see `NEXT_STEPS` in `LandingHero.tsx`); the old step 2
 * — "your agent starts remembering" — promised a result one command does not
 * produce.
 *
 * The copy surface is `landing-get-started`, kept apart from the hero's
 * `landing-hero` so "did the command alone convert" and "did the whole page
 * convert" stay separable in the data. Its links report `landing.cta_clicked`
 * with `placement: 'get-started'` for the same reason.
 */
export function GetStartedCard() {
  return (
    <section
      aria-labelledby={LANDING_SECTION_ID.getStarted}
      className="lk-reveal lk-glow-frame relative mx-auto w-full max-w-3xl overflow-hidden rounded-3xl px-6 py-10 sm:px-12 sm:py-14"
    >
      {/* A warm pool of light at the top edge — the page's last moment of
          colour, behind the final heading. Decorative and static. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(closest-side, var(--color-accent), transparent)' }}
      />

      <div className="relative">
        <p className="mb-3 text-center font-mono text-xs font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]">
          get started
        </p>
        <h2
          id={LANDING_SECTION_ID.getStarted}
          className="mb-3 text-balance text-center text-3xl font-semibold tracking-tight text-[var(--color-content-primary)] sm:text-4xl"
        >
          Give your agents <span className="lk-gradient-text">a memory.</span>
        </h2>
        <p className="mb-10 text-center text-sm text-[var(--color-content-secondary)]">
          Free · Open source · No card, because there is nothing to charge for yet
        </p>

        <ol className="mb-8 space-y-6">
          <li className="flex gap-4">
            <StepBadge step={1} />
            <div className="min-w-0 flex-1">
              <p className="mb-2 text-base font-medium text-[var(--color-content-primary)]">
                Run one command
              </p>
              <CopyCommand
                command="npx @lorekit/cli install"
                commandId="cli-install"
                surface="landing-get-started"
                size="lg"
              />
            </div>
          </li>
          <li className="flex gap-4">
            <StepBadge step={2} />
            <div>
              <p className="mb-1 text-base font-medium text-[var(--color-content-primary)]">
                Paste a token, or go offline
              </p>
              <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">
                <LandingLink
                  href="/login"
                  cta="sign-in"
                  placement="get-started"
                  className={INLINE_LINK_CLASS}
                >
                  Sign in
                </LandingLink>{' '}
                for a free token to share lessons across machines, teammates and CI. Or skip
                it and{' '}
                <LandingLink
                  href="/docs/offline"
                  cta="offline-guide"
                  placement="get-started"
                  className={INLINE_LINK_CLASS}
                >
                  switch to local mode
                </LandingLink>{' '}
                — lessons stay on this machine as markdown you can read and commit.
              </p>
            </div>
          </li>
          <li className="flex gap-4">
            <StepBadge step={3} />
            <div>
              <p className="mb-1 text-base font-medium text-[var(--color-content-primary)]">
                Check it’s wired
              </p>
              <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">
                <code className="rounded bg-[var(--color-bg-elevated)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-accent)]">
                  npx @lorekit/cli doctor
                </code>{' '}
                confirms the connection, the token and the scopes. With hooks on, every
                session after starts with the lessons that apply to it.
              </p>
            </div>
          </li>
        </ol>

        <div className="flex justify-center border-t border-[var(--color-border)] pt-5">
          <LandingLink
            href="/docs"
            cta="docs"
            placement="get-started"
            className="inline-flex items-center gap-1.5 rounded text-sm text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          >
            Explore docs &amp; guides
            <span aria-hidden>→</span>
          </LandingLink>
        </div>
      </div>
    </section>
  );
}
