import { GetStartedButton } from '@/components/learn/GetStartedButton';

import { CopyCommand } from './CopyCommand';

const STEP_BADGE_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] font-mono text-xs font-semibold text-[var(--color-accent)]';

/**
 * The closing call to action on the home page — the same three steps that used
 * to sit on `/login`, now placed where they belong: after the page has said
 * what the product is, rather than above the fold in place of that explanation.
 *
 * Step 1 is deliberately the command and not the sign-in, matching the hero and
 * the actual product: the CLI's offline mode needs no account, so an ordering
 * that put "create an account" first would describe a requirement that does not
 * exist.
 */
export function GetStartedCard() {
  return (
    <section
      aria-labelledby="get-started"
      className="lk-reveal mx-auto w-full max-w-2xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-6 sm:p-8"
    >
      <h2
        id="get-started"
        className="mb-2 text-center text-xl font-semibold text-[var(--color-content-primary)]"
      >
        Get started in 2 minutes
      </h2>
      <p className="mb-6 text-center text-sm text-[var(--color-content-secondary)]">
        Free · Open source · No card, because there is nothing to charge for yet
      </p>

      <ol className="mb-6 space-y-4">
        <li className="flex gap-3">
          <span className={STEP_BADGE_CLASS}>1</span>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-sm font-medium text-[var(--color-content-primary)]">
              Run one command
            </p>
            <CopyCommand
              command="npx @lorekit/cli install"
              commandId="cli-install"
              surface="landing-get-started"
            />
          </div>
        </li>
        <li className="flex gap-3">
          <span className={STEP_BADGE_CLASS}>2</span>
          <div>
            <p className="mb-1 text-sm font-medium text-[var(--color-content-primary)]">
              Your agent starts remembering
            </p>
            <p className="text-sm text-[var(--color-content-secondary)]">
              Lessons persist across sessions on this machine, stored as markdown you can
              read and commit
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className={STEP_BADGE_CLASS}>3</span>
          <div>
            <p className="mb-1 text-sm font-medium text-[var(--color-content-primary)]">
              Sign in when you want them shared
            </p>
            <p className="text-sm text-[var(--color-content-secondary)]">
              A token connects the same store to every machine, teammate, and CI run — and
              brings your local lessons with it
            </p>
          </div>
        </li>
      </ol>

      <GetStartedButton />
    </section>
  );
}
