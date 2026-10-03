const STEPS = [
  {
    title: 'Your agent writes what it learns',
    body: 'One memory.write call when something is worth keeping — a gotcha, a convention, a fix that took three attempts.',
  },
  {
    title: 'The lesson is stored under a scope',
    body: 'This branch, this repo, this project, or everywhere. The scope is what keeps one repository’s lore out of another’s.',
  },
  {
    title: 'The next session reads it back',
    body: 'Narrowest scope first, then wider — so an agent gets this repo’s lessons without drowning in everything else you have ever recorded.',
  },
] as const;

/** The ASCII diagram from the repo README, reused so the front door and the
 *  README describe the product in the same shape. Decorative: the three steps
 *  below carry the same content in prose, which is what a screen reader — and a
 *  phone, where a fixed-width block would need horizontal scrolling — gets
 *  instead. */
const DIAGRAM = `                 ┌─ your agent, any tool, any machine ─┐
learns something │  memory.write { scope, key, value }  │
in a session ───→│                                      │──→ one store, your call:
recalls it next  │  memory.list  { scope }              │←── remote (shared) or local
time it needs it └──────────────────────────────────────┘`;

export function HowItWorks() {
  return (
    <section aria-labelledby="how-it-works" className="lk-reveal w-full max-w-3xl">
      <h2
        id="how-it-works"
        className="mb-2 text-center text-xl font-semibold text-[var(--color-content-primary)]"
      >
        One store. Every agent, every machine.
      </h2>
      <p className="mb-8 text-center text-sm text-[var(--color-content-secondary)]">
        Two MCP tool calls are the whole mechanic.
      </p>

      <pre
        aria-hidden
        className="mb-8 hidden overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5 font-mono text-[11px] leading-relaxed text-[var(--color-content-secondary)] sm:block"
      >
        {DIAGRAM}
      </pre>

      <ol className="grid gap-4 sm:grid-cols-3">
        {STEPS.map(({ title, body }, index) => (
          <li
            key={title}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-5"
          >
            <span className="mb-3 flex size-6 items-center justify-center rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-accent-subtle)] font-mono text-xs font-semibold text-[var(--color-accent)]">
              {index + 1}
            </span>
            <h3 className="mb-1.5 text-sm font-semibold text-[var(--color-content-primary)]">
              {title}
            </h3>
            <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">
              {body}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
