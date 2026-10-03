const LIMITS = [
  'It doesn’t read your codebase. It stores what your agent writes to it, and nothing else.',
  'It doesn’t make an agent smarter on its own. If nothing writes a lesson, there is nothing to read — which is why the plugins wire lifecycle hooks instead of leaving it to the agent’s discretion.',
  'It can surface a lesson you didn’t need. Scopes narrow what an agent sees, grooming prunes what has stopped earning its place, and every memory is visible to you in the dashboard.',
  'Codex support is experimental. Claude Code and Cursor are the supported paths; anything speaking MCP works too.',
  'There is no paid tier yet. If the free limits ever change, your lore exports to plain markdown files you own.',
] as const;

/**
 * The limits, in the product's own voice.
 *
 * This is the section a sceptical developer screenshots, and it is cheaper to
 * write it ourselves than to have someone discover each line on day one. Every
 * entry names something that is true right now — an overstated claim withdrawn
 * later reads as a retraction, while a limit removed later reads as progress.
 */
export function Limitations() {
  return (
    <section aria-labelledby="limitations" className="lk-reveal w-full max-w-2xl">
      <h2
        id="limitations"
        className="mb-6 text-center text-xl font-semibold text-[var(--color-content-primary)]"
      >
        What LoreKit doesn’t do
      </h2>
      <ul className="flex flex-col gap-3">
        {LIMITS.map((limit) => (
          <li
            key={limit}
            className="flex gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] px-5 py-4 text-sm leading-relaxed text-[var(--color-content-secondary)]"
          >
            <span aria-hidden className="select-none font-mono text-[var(--color-content-secondary)]">
              —
            </span>
            {limit}
          </li>
        ))}
      </ul>
    </section>
  );
}
