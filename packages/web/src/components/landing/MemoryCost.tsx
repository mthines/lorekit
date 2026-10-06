/**
 * The section that says memory has a price.
 *
 * It is on the page deliberately. Every lesson injected into a session is paid
 * for in context whether the agent uses it or not, and a memory product that
 * does not say so is selling a cost as a feature. LoreKit measures the ratio
 * and shows it, so the honest version of the claim is also the differentiating
 * one — which is why this sits in the page's own voice rather than in a FAQ.
 */
export function MemoryCost() {
  return (
    <section aria-labelledby="memory-cost" className="lk-reveal w-full max-w-2xl">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-6 sm:p-8">
        <h2
          id="memory-cost"
          className="mb-3 text-xl font-semibold text-[var(--color-content-primary)]"
        >
          Memory isn’t free, so we measure it
        </h2>
        <p className="mb-4 text-sm leading-relaxed text-[var(--color-content-secondary)]">
          Every lesson delivered into a session costs tokens whether the agent uses it or
          not. LoreKit tracks how often each lesson is actually chosen versus merely
          delivered, estimates what your store costs you a month, and shows you the lore
          that is earning nothing.
        </p>
        <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">
          Retention policies then archive it — reviewed by you, or swept nightly, and
          never a hard delete.
        </p>
      </div>
    </section>
  );
}
