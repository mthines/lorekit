import { SectionHeading } from './SectionHeading';
import { StepBadge } from './StepBadge';

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
    <section aria-labelledby="how-it-works" className="lk-reveal w-full max-w-5xl">
      <SectionHeading
        id="how-it-works"
        eyebrow="02 / how it works"
        title={
          <>
            One store. <span className="lk-gradient-text">Every agent, every machine.</span>
          </>
        }
        lede="Two MCP tool calls are the whole mechanic. The CLI wires the hooks that make your agent call them."
      />

      {/* Framed like a file so it reads as the README excerpt it is. */}
      <figure
        aria-hidden
        className="mx-auto mb-12 hidden max-w-3xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80 sm:block"
      >
        <figcaption className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 py-2 font-mono text-[11px] text-[var(--color-content-secondary)]">
          README.md
        </figcaption>
        <pre className="overflow-x-auto p-5 font-mono text-[11px] leading-relaxed text-[var(--color-content-secondary)]">
          {DIAGRAM}
        </pre>
      </figure>

      {/* The connecting rule runs through the badges on wide screens, so the
          three cards read as one left-to-right sequence rather than a grid of
          unrelated features. */}
      <ol className="relative grid gap-5 sm:grid-cols-3">
        <span
          aria-hidden
          className="pointer-events-none absolute left-[16.6%] right-[16.6%] top-[38px] hidden h-px bg-gradient-to-r from-transparent via-[var(--color-accent)]/50 to-transparent sm:block"
        />
        {STEPS.map(({ title, body }, index) => (
          <li
            key={title}
            className="relative flex flex-col items-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-raised)]/80 p-6 text-center transition-colors duration-200 hover:border-[var(--color-accent)]/40"
          >
            <StepBadge step={index + 1} />
            <h3 className="mb-2 mt-4 text-base font-semibold text-[var(--color-content-primary)]">
              {title}
            </h3>
            <p className="text-sm leading-relaxed text-[var(--color-content-secondary)]">{body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
