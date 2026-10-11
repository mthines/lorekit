/**
 * The numbered circle that marks a step, shared by "How it works" and the
 * closing "Get started" list so the two step sequences on the page are visibly
 * the same kind of thing. It used to be one class string copied into both
 * files, which is how two badges drift a pixel apart.
 *
 * Decorative to assistive tech: both lists are `<ol>`, which already announces
 * "1 of 3", so reading the digit again would say every number twice.
 */
export function StepBadge({ step }: { step: number }) {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] font-mono text-xs font-semibold text-[var(--color-accent)] shadow-[0_0_16px_var(--color-accent-glow)]"
    >
      {step}
    </span>
  );
}
